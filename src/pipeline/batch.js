import fs from 'node:fs';
import path from 'node:path';
import { log } from '../util/log.js';

/**
 * Agrupa páginas em lotes de BATCH_SIZE com BATCH_OVERLAP páginas de overlap.
 * Saída: batches/batch-NNN.json com { id, pages: [{page, type, text, image, figures, needs_vision}] }
 */
export function buildBatches(rawDir, batchesDir) {
  const manifestPath = path.join(rawDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const size = parseInt(process.env.BATCH_SIZE || '5', 10);
  const overlap = parseInt(process.env.BATCH_OVERLAP || '1', 10);
  const stride = Math.max(1, size - overlap);

  fs.mkdirSync(batchesDir, { recursive: true });

  const batches = [];
  for (let start = 0; start < manifest.length; start += stride) {
    const slice = manifest.slice(start, start + size);
    if (slice.length === 0) break;

    const pages = slice.map(m => {
      const txtPath = m.text_file ? path.join(rawDir, m.text_file) : null;
      const text = txtPath && fs.existsSync(txtPath) ? fs.readFileSync(txtPath, 'utf8') : '';
      return {
        page: m.page,
        type: m.type,
        text,
        image: m.image,
        figures: m.figures || [],
        needs_vision: !!m.needs_vision,
        ocr_confidence: m.ocr_confidence ?? null,
        text_source: m.text_source || null,
      };
    });

    const id = `batch-${String(batches.length + 1).padStart(3, '0')}`;
    const batch = {
      id,
      first_page: pages[0].page,
      last_page: pages[pages.length - 1].page,
      overlap_pages: start === 0 ? [] : pages.slice(0, overlap).map(p => p.page),
      needs_vision: pages.some(p => p.needs_vision),
      pages,
    };
    fs.writeFileSync(path.join(batchesDir, `${id}.json`), JSON.stringify(batch, null, 2));
    batches.push(id);

    if (start + size >= manifest.length) break;
  }

  log.ok(`batch: ${batches.length} lotes (size=${size}, overlap=${overlap})`);
  return batches;
}
