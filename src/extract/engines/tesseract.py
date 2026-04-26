"""Tesseract engine. Retorna (text, confidence in [0,1])."""
import os
import sys

_pt = None


def _load():
    global _pt
    if _pt is None:
        try:
            import pytesseract
            cmd = os.environ.get("TESSERACT_CMD")
            if cmd:
                pytesseract.pytesseract.tesseract_cmd = cmd
            _pt = pytesseract
        except Exception as e:
            print(f"[tesseract] indisponível: {e}", file=sys.stderr)
            _pt = False
    return _pt


def run(image_path):
    pt = _load()
    if not pt:
        return None, 0.0
    try:
        from PIL import Image
        lang = os.environ.get("TESSERACT_LANG", "por")
        img = Image.open(image_path)
        data = pt.image_to_data(img, lang=lang, output_type=pt.Output.DICT)
        texts = [t for t, c in zip(data["text"], data["conf"]) if t.strip() and c != "-1"]
        confs = [int(c) for c in data["conf"] if c != "-1" and int(c) >= 0]
        text = "\n".join(texts)
        avg = (sum(confs) / len(confs) / 100.0) if confs else 0.0
        return text, avg
    except Exception as e:
        print(f"[tesseract] erro {image_path}: {e}", file=sys.stderr)
        return None, 0.0
