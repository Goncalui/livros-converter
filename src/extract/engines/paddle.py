"""PaddleOCR engine (compatível com v2 e v3). Retorna (text, confidence in [0,1])."""
import os
import sys
import glob

_paddle = None
_api_version = None  # "v3" ou "v2"


def _add_cuda_dlls_to_path():
    """No Windows, paddlepaddle-gpu requer DLLs CUDA/cuDNN no PATH."""
    if sys.platform != "win32":
        return
    try:
        import sysconfig
        site_pkgs = sysconfig.get_paths()["purelib"]
        nvidia_root = os.path.join(site_pkgs, "nvidia")
        if not os.path.isdir(nvidia_root):
            return
        for sub in os.listdir(nvidia_root):
            for cand in (os.path.join(nvidia_root, sub, "bin"),
                         os.path.join(nvidia_root, sub, "lib")):
                if os.path.isdir(cand):
                    try: os.add_dll_directory(cand)
                    except Exception: pass
                    os.environ["PATH"] = cand + os.pathsep + os.environ.get("PATH", "")
    except Exception as e:
        print(f"[paddle] aviso adicionando CUDA DLLs: {e}", file=sys.stderr)


def _load():
    global _paddle, _api_version
    if _paddle is not None:
        return _paddle
    _add_cuda_dlls_to_path()
    try:
        from paddleocr import PaddleOCR
        lang = os.environ.get("PADDLE_OCR_LANG", "pt")
        # Tenta API v3 (predict + flags novos)
        try:
            ver = os.environ.get("PADDLE_OCR_VERSION", "PP-OCRv5")
            kwargs = dict(
                lang=lang,
                ocr_version=ver,
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=False,
            )
            # Modelos "server" do v5 disparam bug PIR/OneDNN no Windows; força mobile.
            # Para PT, o rec correto é latin_PP-OCRv5_mobile_rec (cobre português).
            if os.environ.get("PADDLE_FORCE_MOBILE", "1") == "1" and ver == "PP-OCRv5":
                kwargs["text_detection_model_name"] = "PP-OCRv5_mobile_det"
                rec_lang_map = {"pt": "latin", "es": "latin", "it": "latin",
                                "fr": "latin", "de": "latin"}
                rec_lang = rec_lang_map.get(lang, lang)
                kwargs["text_recognition_model_name"] = f"{rec_lang}_PP-OCRv5_mobile_rec"
            _paddle = PaddleOCR(**kwargs)
            _api_version = "v3"
        except TypeError:
            # Fallback v2 (use_angle_cls + show_log)
            _paddle = PaddleOCR(use_angle_cls=True, lang=lang, show_log=False)
            _api_version = "v2"
        print(f"[paddle] inicializado (api={_api_version}, lang={lang})", file=sys.stderr)
    except Exception as e:
        print(f"[paddle] indisponível: {e}", file=sys.stderr)
        _paddle = False
    return _paddle


def _run_v3(p, image_path):
    """v3: p.predict(img) → list[dict] com rec_texts/rec_scores/rec_polys."""
    res = p.predict(str(image_path))
    if not res:
        return "", 0.0
    r0 = res[0]
    texts = []
    confs = []
    if hasattr(r0, "json"):
        try:
            data = r0.json
            res_dict = data.get("res", data) if isinstance(data, dict) else {}
        except Exception:
            res_dict = r0 if isinstance(r0, dict) else {}
    elif isinstance(r0, dict):
        res_dict = r0
    else:
        res_dict = {}
    texts = res_dict.get("rec_texts") or res_dict.get("texts") or []
    confs = res_dict.get("rec_scores") or res_dict.get("scores") or []
    avg = (sum(map(float, confs)) / len(confs)) if confs else 0.0
    return "\n".join(texts), avg


def _run_v2(p, image_path):
    result = p.ocr(str(image_path), cls=True)
    if not result or not result[0]:
        return "", 0.0
    lines, confs = [], []
    for box, (text, conf) in result[0]:
        lines.append(text)
        confs.append(float(conf))
    avg = sum(confs) / len(confs) if confs else 0.0
    return "\n".join(lines), avg


def run(image_path):
    p = _load()
    if not p:
        return None, 0.0
    try:
        if _api_version == "v3":
            return _run_v3(p, image_path)
        return _run_v2(p, image_path)
    except Exception as e:
        print(f"[paddle] erro {image_path}: {e}", file=sys.stderr)
        return None, 0.0
