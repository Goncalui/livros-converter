"""
Router OCR com modos plugáveis.

Modos (env OCR_MODE):
  paddle               PaddleOCR; fallback Tesseract se conf < min
  glm                  GLM-OCR; fallback Paddle se vazio
  paddle-then-glm      Paddle primeiro; se conf baixa, escala para GLM
  glm-then-paddle      GLM primeiro; se vazio/ruim, fallback Paddle
  compare              roda Paddle + GLM (+ Tesseract se quiser),
                       salva todas as saídas e escolhe vencedor por métrica

Saída por página:
  page-NNN.txt                       texto vencedor (consumido pela pipeline)
  page-NNN.<engine>.txt              cada engine (modo compare)
  page-NNN.compare.json              métricas + vencedor (modo compare)
  manifest.json                      atualizado com text_source, confidence, etc.

Uso:
    python ocr.py <raw_dir> [--mode compare] [--min-confidence 0.80]
"""
import os
import sys
import json
import argparse
from pathlib import Path

from engines import paddle as eng_paddle
from engines import tesseract as eng_tess
from engines import glm as eng_glm
from engines.compare import metrics, pick_winner


def write_text(path: Path, text: str):
    path.write_text(text or "", encoding="utf-8")


def run_engine(name, image_path):
    """Executa engine retornando dict {text, confidence, layout?}"""
    if name == "paddle":
        text, conf = eng_paddle.run(image_path)
        return {"text": text, "confidence": conf, "layout": None}
    if name == "tesseract":
        text, conf = eng_tess.run(image_path)
        return {"text": text, "confidence": conf, "layout": None}
    if name == "glm":
        text, conf, layout = eng_glm.run(image_path)
        return {"text": text, "confidence": conf, "layout": layout}
    raise ValueError(f"engine desconhecido: {name}")


def process_paddle(img, min_conf):
    r = run_engine("paddle", img)
    if r["text"] is None or r["confidence"] < min_conf:
        t = run_engine("tesseract", img)
        if t["text"] and t["confidence"] > (r["confidence"] or 0):
            return t["text"], t["confidence"], "tesseract", None
    return r["text"] or "", r["confidence"], "paddle", None


def process_glm(img):
    r = run_engine("glm", img)
    if r["text"]:
        return r["text"], r["confidence"], "glm", r["layout"]
    p = run_engine("paddle", img)
    return p["text"] or "", p["confidence"], "paddle", None


def process_paddle_then_glm(img, min_conf):
    p = run_engine("paddle", img)
    if p["text"] and p["confidence"] >= min_conf:
        return p["text"], p["confidence"], "paddle", None
    g = run_engine("glm", img)
    if g["text"]:
        return g["text"], g["confidence"], "glm", g["layout"]
    return p["text"] or "", p["confidence"], "paddle", None


def process_glm_then_paddle(img, min_conf):
    g = run_engine("glm", img)
    if g["text"] and g["confidence"] >= min_conf:
        return g["text"], g["confidence"], "glm", g["layout"]
    p = run_engine("paddle", img)
    if p["text"]:
        return p["text"], p["confidence"], "paddle", None
    return g["text"] or "", g["confidence"], "glm", g["layout"]


def process_compare(img, raw_dir, page_idx, include_tesseract=False):
    candidates = {}

    p = run_engine("paddle", img)
    candidates["paddle"] = {"text": p["text"], "confidence": p["confidence"]}
    if p["text"] is not None:
        write_text(raw_dir / f"page-{page_idx:03d}.paddle.txt", p["text"])

    g = run_engine("glm", img)
    candidates["glm"] = {"text": g["text"], "confidence": g["confidence"], "layout": g["layout"]}
    if g["text"] is not None:
        write_text(raw_dir / f"page-{page_idx:03d}.glm.txt", g["text"])
        if g["layout"] is not None:
            (raw_dir / f"page-{page_idx:03d}.glm.json").write_text(
                json.dumps(g["layout"], ensure_ascii=False, indent=2), encoding="utf-8"
            )

    if include_tesseract:
        t = run_engine("tesseract", img)
        candidates["tesseract"] = {"text": t["text"], "confidence": t["confidence"]}
        if t["text"] is not None:
            write_text(raw_dir / f"page-{page_idx:03d}.tesseract.txt", t["text"])

    # métricas
    report = {}
    for name, c in candidates.items():
        m = metrics(c.get("text"), c.get("confidence", 0.0))
        report[name] = {"metrics": m, "text": c.get("text") or ""}

    winner = pick_winner(report)
    out = {
        "page": page_idx,
        "winner": winner,
        "engines": {k: v["metrics"] for k, v in report.items()},
    }
    (raw_dir / f"page-{page_idx:03d}.compare.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    if winner is None:
        return "", 0.0, "none", None
    chosen = report[winner]["text"]
    chosen_conf = report[winner]["metrics"]["confidence"]
    layout = candidates["glm"].get("layout") if winner == "glm" else None
    return chosen, chosen_conf, winner, layout


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("raw_dir")
    ap.add_argument("--mode", default=os.environ.get("OCR_MODE", "paddle"))
    ap.add_argument("--min-confidence", type=float,
                    default=float(os.environ.get("OCR_MIN_CONFIDENCE", "0.80")))
    ap.add_argument("--include-tesseract-in-compare", action="store_true",
                    default=os.environ.get("COMPARE_INCLUDE_TESSERACT", "0") == "1")
    args = ap.parse_args()

    raw_dir = Path(args.raw_dir).resolve()
    manifest_path = raw_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    print(f"[ocr] modo={args.mode} min_conf={args.min_confidence}", flush=True)

    # Modo GLM puro com batching: processa em chunks e flusha disk a cada chunk
    # (essencial para o pipeline de streaming, que polla os arquivos por página).
    if args.mode == "glm":
        from engines import glm as eng_glm
        scanned = [e for e in manifest if e["type"] == "escaneado"]
        if scanned:
            batch_size = int(os.environ.get("GLM_OCR_BATCH_SIZE", "2"))
            print(f"[ocr] GLM batch_size={batch_size} sobre {len(scanned)} páginas", flush=True)
            for cs in range(0, len(scanned), batch_size):
                chunk = scanned[cs:cs + batch_size]
                paths = [raw_dir / e["image"] for e in chunk]
                results = eng_glm.run_batch(paths, batch_size=batch_size)
                for entry, (text, conf, _layout) in zip(chunk, results):
                    i = entry["page"]
                    src = "glm" if text else "none"
                    out = raw_dir / f"page-{i:03d}.txt"
                    write_text(out, text or "")
                    entry["text_file"] = out.name
                    entry["text_source"] = src
                    entry["ocr_confidence"] = round(conf, 4)
                    entry["needs_vision"] = conf < args.min_confidence
                    print(f"[ocr] página {i} → {src} conf={conf:.2f}", flush=True)
                # flush manifest após cada chunk
                manifest_path.write_text(
                    json.dumps(manifest, ensure_ascii=False, indent=2),
                    encoding="utf-8")
        return

    for entry in manifest:
        if entry["type"] != "escaneado":
            continue
        i = entry["page"]
        img = raw_dir / entry["image"]

        if args.mode == "skip":
            # Não roda OCR; força pipeline a usar LLM-vision.
            out = raw_dir / f"page-{i:03d}.txt"
            write_text(out, "")
            entry["text_file"] = out.name
            entry["text_source"] = "skipped"
            entry["ocr_confidence"] = 0.0
            entry["needs_vision"] = True
            print(f"[ocr] página {i} → SKIP (vision-only)", flush=True)
            continue

        if args.mode == "paddle":
            text, conf, source, layout = process_paddle(img, args.min_confidence)
        elif args.mode == "glm":
            text, conf, source, layout = process_glm(img)
        elif args.mode == "paddle-then-glm":
            text, conf, source, layout = process_paddle_then_glm(img, args.min_confidence)
        elif args.mode == "glm-then-paddle":
            text, conf, source, layout = process_glm_then_paddle(img, args.min_confidence)
        elif args.mode == "compare":
            text, conf, source, layout = process_compare(
                img, raw_dir, i, include_tesseract=args.include_tesseract_in_compare
            )
        else:
            print(f"[ocr] modo desconhecido: {args.mode}", file=sys.stderr)
            sys.exit(2)

        out = raw_dir / f"page-{i:03d}.txt"
        write_text(out, text)
        entry["text_file"] = out.name
        entry["text_source"] = source
        entry["ocr_confidence"] = round(conf, 4)
        entry["needs_vision"] = conf < args.min_confidence
        if layout is not None:
            entry["glm_layout_file"] = f"page-{i:03d}.glm.json"
        if args.mode == "compare":
            entry["compare_file"] = f"page-{i:03d}.compare.json"

        flag = " (precisa vision)" if entry["needs_vision"] else ""
        print(f"[ocr] página {i} → vencedor={source} conf={conf:.2f}{flag}", flush=True)

    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
