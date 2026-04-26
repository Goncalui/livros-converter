"""
GLM-OCR engine via transformers diretamente (sem servidor vLLM/SGLang).
Modelo: zai-org/GLM-OCR (~0.9B vision-language). Roda em GPU CUDA.

Carrega o modelo uma vez (singleton) e reusa entre chamadas.
Suporta batching de N imagens via run_batch(paths, batch_size).
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
        dtype_name = os.environ.get("GLM_OCR_DTYPE", "fp16").lower()
        _dtype = {
            "fp32": torch.float32, "float32": torch.float32,
            "fp16": torch.float16, "float16": torch.float16, "half": torch.float16,
            "bf16": torch.bfloat16, "bfloat16": torch.bfloat16,
        }.get(dtype_name, torch.float16)
        print(f"[glm] carregando zai-org/GLM-OCR em {_device} ({dtype_name})...", file=sys.stderr)

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


def _generate_for_messages(messages_list, max_new):
    """Roda model.generate em uma lista de conversas (batch). Retorna lista de strings."""
    import torch
    inputs = _proc.apply_chat_template(
        messages_list,
        add_generation_prompt=True,
        tokenize=True,
        return_tensors="pt",
        return_dict=True,
        padding=True,
    ).to(_device, _dtype)

    with torch.inference_mode():
        out = _model.generate(
            **inputs,
            max_new_tokens=max_new,
            do_sample=False,
            num_beams=1,
        )
    input_len = inputs.input_ids.shape[-1]
    texts = []
    for i in range(out.shape[0]):
        gen_ids = out[i, input_len:]
        texts.append(_proc.tokenizer.decode(gen_ids, skip_special_tokens=True))
    return texts


def _build_messages(img):
    prompt = os.environ.get("GLM_OCR_PROMPT", "OCR")
    return [{
        "role": "user",
        "content": [
            {"type": "image", "image": img},
            {"type": "text", "text": prompt},
        ],
    }]


def run(image_path):
    """Retorna (markdown_text, confidence_heuristic, layout_or_none) para 1 imagem."""
    mdl = _load()
    if not mdl:
        return None, 0.0, None
    try:
        from PIL import Image
        img = Image.open(str(image_path)).convert("RGB")
        max_new = int(os.environ.get("GLM_OCR_MAX_NEW_TOKENS", "2048"))
        texts = _generate_for_messages([_build_messages(img)], max_new)
        text = texts[0]
        conf = _heuristic_confidence(text)
        return text, conf, None
    except Exception as e:
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(f"[glm] erro {image_path}: {e}", file=sys.stderr)
        return None, 0.0, None


def run_batch(image_paths, batch_size=None):
    """Processa N imagens em lotes na GPU. Retorna lista [(text, conf, None), ...] na mesma ordem.

    batch_size default vem de GLM_OCR_BATCH_SIZE (env), fallback 3.
    Se batch falhar, cai para per-imagem.
    """
    mdl = _load()
    if not mdl:
        return [(None, 0.0, None) for _ in image_paths]

    if batch_size is None:
        batch_size = int(os.environ.get("GLM_OCR_BATCH_SIZE", "3"))
    batch_size = max(1, batch_size)
    max_new = int(os.environ.get("GLM_OCR_MAX_NEW_TOKENS", "2048"))

    from PIL import Image
    results = [None] * len(image_paths)

    for start in range(0, len(image_paths), batch_size):
        chunk = image_paths[start:start + batch_size]
        try:
            imgs = [Image.open(str(p)).convert("RGB") for p in chunk]
            messages_list = [_build_messages(img) for img in imgs]
            texts = _generate_for_messages(messages_list, max_new)
            for i, txt in enumerate(texts):
                results[start + i] = (txt, _heuristic_confidence(txt), None)
            print(f"[glm] batch {start+1}-{start+len(chunk)}/{len(image_paths)} OK", file=sys.stderr)
        except Exception as e:
            print(f"[glm] batch falhou ({e}); caindo pra single", file=sys.stderr)
            for i, p in enumerate(chunk):
                results[start + i] = run(p)

    return results
