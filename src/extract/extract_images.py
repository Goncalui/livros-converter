"""
Extrai figuras embutidas em PDFs nativos para cada página.
Salva em raw/images/page-NNN-fig-MMM.png e atualiza o manifest.

Uso:
    python extract_images.py <raw_dir>
"""
import sys
import json
from pathlib import Path

import fitz


def main():
    if len(sys.argv) < 2:
        print("uso: extract_images.py <raw_dir>", file=sys.stderr)
        sys.exit(2)

    raw_dir = Path(sys.argv[1]).resolve()
    manifest_path = raw_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    pdf_path = next((m["source_pdf"] for m in manifest if m["source_pdf"]), None)
    if not pdf_path:
        print("[extract_images] nada para extrair (sem PDF)")
        return

    img_dir = raw_dir / "images"
    img_dir.mkdir(exist_ok=True)

    doc = fitz.open(pdf_path)
    for entry in manifest:
        if entry["type"] != "nativo":
            continue
        i = entry["page"]
        page = doc[i - 1]
        figs = []
        for j, img in enumerate(page.get_images(full=True), start=1):
            xref = img[0]
            try:
                pix = fitz.Pixmap(doc, xref)
                if pix.n - pix.alpha >= 4:
                    pix = fitz.Pixmap(fitz.csRGB, pix)
                fname = f"page-{i:03d}-fig-{j:03d}.png"
                pix.save(img_dir / fname)
                figs.append(fname)
                pix = None
            except Exception as e:
                print(f"[extract_images] erro pág {i} fig {j}: {e}", file=sys.stderr)
        entry["figures"] = figs
        if figs:
            print(f"[extract_images] página {i} → {len(figs)} figura(s)", flush=True)
    doc.close()

    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
