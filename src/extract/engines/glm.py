"""
GLM-OCR engine via transformers diretamente (sem servidor vLLM/SGLang).
Modelo: zai-org/GLM-OCR (~0.9B vision-language). Roda em GPU CUDA.

Carrega o modelo uma vez (singleton) e reusa entre chamadas.
"""
import os
import sys

_proc = None
_model = None
_device = None
_dtype = None


def _load():
    global _proc, _model, _device, _dtype
    if _model is not None:
        return _model
    try:
        import torch
        from transformers import AutoProcessor
        from transformers.models.glm_ocr import GlmOcrForConditionalGeneration

        cuda_dev = os.environ.get("CUDA_VISIBLE_DEVICES", "0")
        if cuda_dev:
            os.environ["CUDA_VISIBLE_DEVICES"] = cuda_dev

        _device = "cuda" if torch.cuda.is_available() else "cpu"
        _dtype = torch.float16 if _device == "cuda" else torch.float32
        print(f"[glm] carregando zai-org/GLM-OCR em {_device}...", file=sys.stderr)

        _proc = AutoProcessor.from_pretrained("zai-org/GLM-OCR", trust_remote_code=True)
        _model = GlmOcrForConditionalGeneration.from_pretrained(
            "zai-org/GLM-OCR",
            dtype=_dtype,
            device_map=_device,
        )
        _model.eval()
        if _device == "cuda":
            mem = torch.cuda.memory_allocated() / 1e9
            print(f"[glm] pronto. GPU mem: {mem:.2f} GB", file=sys.stderr)
        return _model
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(f"[glm] indisponível: {e}", file=sys.stderr)
        _model = False
        return False


def _heuristic_confidence(md: str) -> float:
    if not md or not md.strip():
        return 0.0
    score = 0.55
    if "# " in md or "## " in md or "### " in md: score += 0.10
    if "|" in md and "\n|" in md:                  score += 0.10
    if "- " in md or "* " in md:                   score += 0.05
    if "$$" in md or r"\(" in md or r"\frac" in md: score += 0.05
    if "**" in md:                                 score += 0.05
    weird = sum(1 for c in md if ord(c) < 32 and c not in "\n\t\r")
    if len(md) > 0:
        score -= min(0.30, weird / len(md) * 5)
    return max(0.0, min(1.0, score))


def run(image_path):
    """Retorna (markdown_text, confidence_heuristic, layout_or_none)."""
    mdl = _load()
    if not mdl:
        return None, 0.0, None
    try:
        import torch
        from PIL import Image

        img = Image.open(str(image_path)).convert("RGB")
        prompt = os.environ.get("GLM_OCR_PROMPT", "OCR")

        messages = [{
            "role": "user",
            "content": [
                {"type": "image", "image": img},
                {"type": "text", "text": prompt},
            ],
        }]
        inputs = _proc.apply_chat_template(
            messages, add_generation_prompt=True, tokenize=True,
            return_tensors="pt", return_dict=True,
        ).to(_device, _dtype)

        max_new = int(os.environ.get("GLM_OCR_MAX_NEW_TOKENS", "4096"))
        with torch.inference_mode():
            out = _model.generate(
                **inputs,
                max_new_tokens=max_new,
                do_sample=False,
                num_beams=1,
            )
        gen_ids = out[0, inputs.input_ids.shape[-1]:]
        text = _proc.tokenizer.decode(gen_ids, skip_special_tokens=True)
        conf = _heuristic_confidence(text)
        return text, conf, None
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(f"[glm] erro {image_path}: {e}", file=sys.stderr)
        return None, 0.0, None
