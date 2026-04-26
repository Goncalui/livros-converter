import fs from 'node:fs';
import path from 'node:path';
import { callLLM } from '../llm/router.js';
import { log } from '../util/log.js';

let _basePrompt = null;
function basePrompt(promptPath) {
  if (_basePrompt) return _basePrompt;
  _basePrompt = fs.readFileSync(promptPath, 'utf8');
  return _basePrompt;
}

function buildBatchPrompt(promptPath, batch) {
  const base = basePrompt(promptPath);
  const blocks = batch.pages.map(p => {
    const header = `--- PÁGINA ${p.page} (${p.type}, fonte=${p.text_source || 'n/a'}, conf=${p.ocr_confidence ?? 'n/a'}) ---`;
    const figs = p.figures?.length ? `\n[figuras anexas: ${p.figures.join(', ')}]` : '';
    const txt = p.text?.trim() || '[SEM TEXTO EXTRAÍDO — usar imagem]';
    return `${header}\n${txt}${figs}`;
  }).join('\n\n');

  const overlapNote = batch.overlap_pages.length
    ? `\n\nNOTA DE CONTINUIDADE: as páginas ${batch.overlap_pages.join(', ')} foram incluídas como contexto do lote anterior. NÃO duplique conteúdo já convertido — use-as apenas para resolver quebras de parágrafo/tabela. Comece a saída a partir da primeira página NÃO sobreposta.\n`
    : '';

  return `${base}\n\n# MATERIAL DE ENTRADA\n\nLote: ${batch.id} · Páginas ${batch.first_page}–${batch.last_page}${overlapNote}\n\n${blocks}\n\n--- FIM DO MATERIAL ---\n\nConverta agora seguindo rigorosamente todas as instruções do prompt.`;
}

/**
 * Processa lotes pendentes em sequência, salvando batch-NNN.md e atualizando state.
 */
export async function convertBatches({ batchesDir, outDir, promptPath, state, onProgress }) {
  fs.mkdirSync(outDir, { recursive: true });
  const allBatches = fs.readdirSync(batchesDir)
    .filter(f => f.startsWith('batch-') && f.endsWith('.json'))
    .sort();

  state.data.stages.convert.batchesTotal = allBatches.length;
  state.save();

  for (const file of allBatches) {
    const id = file.replace('.json', '');
    const outFile = path.join(outDir, `${id}.md`);
    if (state.data.stages.convert.batchesDone.includes(id) && fs.existsSync(outFile)) {
      log.info(`convert: ${id} já concluído, pulando`);
      continue;
    }

    const batch = JSON.parse(fs.readFileSync(path.join(batchesDir, file), 'utf8'));
    state.data.currentBatch = id;
    state.save();

    const prompt = buildBatchPrompt(promptPath, batch);
    const images = [];
    const visionEnabled = (process.env.LLM_VISION_ESCALATION ?? '1') !== '0';
    if (visionEnabled && batch.needs_vision) {
      // Anexa imagens das páginas com OCR ruim (LLM_VISION_ESCALATION=0 desativa)
      const rawDir = path.resolve(batchesDir, '..', 'raw');
      for (const p of batch.pages) {
        if (p.needs_vision && p.image) images.push(path.join(rawDir, p.image));
      }
    }

    log.step(`convert: ${id} (págs ${batch.first_page}–${batch.last_page}${images.length ? `, ${images.length} imgs` : ''})`);
    const t0 = Date.now();
    let result;
    try {
      result = await callLLM(prompt, { images });
    } catch (e) {
      log.err(`convert: ${id} falhou: ${e.message}`);
      throw e;
    }
    const dt = ((Date.now() - t0) / 1000).toFixed(1);

    fs.writeFileSync(outFile, result.text);
    state.recordBatch(id, true);
    state.recordLLM(result.provider, result.fallback);
    state.data.lastMarkdownPreview = {
      batch: id,
      provider: result.provider,
      pages: `${batch.first_page}-${batch.last_page}`,
      seconds: parseFloat(dt),
      preview: result.text.slice(0, 4000),
      length: result.text.length,
      at: new Date().toISOString(),
    };
    state.save();

    log.ok(`convert: ${id} ok via ${result.provider}${result.fallback ? ' (fallback)' : ''} em ${dt}s`);
    onProgress?.({ id, provider: result.provider, dt, total: allBatches.length });
  }

  state.data.currentBatch = null;
  state.save();
}
