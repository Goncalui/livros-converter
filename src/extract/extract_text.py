"""
Extrai texto nativo das páginas marcadas como 'nativo' no manifest.

Uso:
    python extract_text.py <raw_dir>
"""
import sys
import json
from pathlib import Path

import fitz


def main():
    if len(sys.argv) < 2:
        print("uso: extract_text.py <raw_dir>", file=sys.stderr)
        sys.exit(2)

    raw_dir = Path(sys.argv[1]).resolve()
    manifest_path = raw_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    # Agrupa por PDF (assume um PDF por workspace)
    pdf_path = next((m["source_pdf"] for m in manifest if m["source_pdf"]), None)
    if not pdf_path:
        print("[extract_text] nada para extrair (sem PDF nativo)")
        return

    doc = fitz.open(pdf_path)
    for entry in manifest:
        if entry["type"] != "nativo":
            continue
        i = entry["page"]
        text = doc[i - 1].get_text("text")
        out = raw_dir / f"page-{i:03d}.txt"
        out.write_text(text, encoding="utf-8")
        entry["text_file"] = out.name
        entry["text_source"] = "native"
        print(f"[extract_text] página {i} → {out.name} ({len(text)} chars)", flush=True)
    doc.close()

    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
