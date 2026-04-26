"""
Classifica cada página de um PDF como 'nativo' (tem texto extraível)
ou 'escaneado' (precisa OCR). Aceita também pasta de imagens.

Saída: workspace/<slug>/raw/manifest.json com:
[
  {"page": 1, "type": "nativo", "source_pdf": "livro.pdf", "image": "page-001.png"},
  {"page": 2, "type": "escaneado", ...}
]

Uso:
    python classify.py <input> <workspace_raw_dir>
"""
import sys
import json
import os
from pathlib import Path

import fitz  # PyMuPDF


MIN_TEXT_CHARS = 40  # abaixo disso considera escaneado


def classify_pdf(pdf_path: Path, raw_dir: Path):
    raw_dir.mkdir(parents=True, exist_ok=True)
    doc = fitz.open(pdf_path)
    manifest = []

    for i, page in enumerate(doc, start=1):
        text = page.get_text("text").strip()
        is_native = len(text) >= MIN_TEXT_CHARS

        # Render PNG sempre — útil para vision fallback e OCR
        pix = page.get_pixmap(dpi=200)
        img_name = f"page-{i:03d}.png"
        pix.save(raw_dir / img_name)

        manifest.append({
            "page": i,
            "type": "nativo" if is_native else "escaneado",
            "source_pdf": str(pdf_path),
            "image": img_name,
            "char_count": len(text),
        })
        print(f"[classify] página {i}/{len(doc)} → {'nativo' if is_native else 'escaneado'}", flush=True)

    doc.close()
    return manifest


def classify_image_folder(folder: Path, raw_dir: Path):
    raw_dir.mkdir(parents=True, exist_ok=True)
    exts = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"}
    images = sorted([p for p in folder.iterdir() if p.suffix.lower() in exts])
    manifest = []
    for i, src in enumerate(images, start=1):
        img_name = f"page-{i:03d}{src.suffix.lower()}"
        dst = raw_dir / img_name
        if not dst.exists():
            # Prefere symlink (rápido, não duplica MB no Drive FUSE).
            # Fallback para cópia se symlink falhar (Windows sem perms, etc).
            try:
                os.symlink(src, dst)
            except OSError:
                dst.write_bytes(src.read_bytes())
        manifest.append({
            "page": i,
            "type": "escaneado",
            "source_pdf": None,
            "image": img_name,
            "char_count": 0,
        })
        print(f"[classify] página {i}/{len(images)} → escaneado (imagem)", flush=True)
    return manifest


def main():
    if len(sys.argv) < 3:
        print("uso: classify.py <input> <raw_dir>", file=sys.stderr)
        sys.exit(2)

    inp = Path(sys.argv[1]).resolve()
    raw_dir = Path(sys.argv[2]).resolve()

    if not inp.exists():
        print(f"input não encontrado: {inp}", file=sys.stderr)
        sys.exit(1)

    if inp.is_file() and inp.suffix.lower() == ".pdf":
        manifest = classify_pdf(inp, raw_dir)
    elif inp.is_dir():
        manifest = classify_image_folder(inp, raw_dir)
    else:
        print("input deve ser PDF ou diretório de imagens", file=sys.stderr)
        sys.exit(1)

    with open(raw_dir / "manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    print(f"[classify] manifest salvo: {raw_dir / 'manifest.json'} ({len(manifest)} páginas)")


if __name__ == "__main__":
    main()
