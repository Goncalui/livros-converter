import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { log } from '../util/log.js';
import { callLLM } from '../llm/router.js';
import { writeFileSyncDurable } from '../util/fsync.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

let _basePrompt = null;
function basePrompt(p) { return _basePrompt ??= fs.readFileSync(p, 'utf8'); }

function buildBatchPrompt(promptPath, batch) {
  const base = basePrompt(promptPath);
  const blocks = batch.pages.map(p => {
    const header = `--- PÁGINA ${p.page} (${p.type}, fonte=${p.text_source || 'n/a'}, conf=${p.ocr_confidence ?? 'n/a'}) ---`;
    const figs = p.figures?.length ? `\n[figuras anexas: ${p.figures.join(', ')}]` : '';
    const txt = p.text?.trim() || '[SEM TEXTO EXTRAÍDO — usar imagem]';
    return `${header}\n${txt}${figs}`;
  }).join('\n\n');
  const overlapNote = batch.overlap_pages.length
    ? `\n\nNOTA DE CONTINUIDADE: páginas ${batch.overlap_pages.join(', ')} são contexto do lote anterior. NÃO duplique conteúdo já convertido.\n`
    : '';
  return `${base}\n\n# MATERIAL DE ENTRADA\n\nLote: ${batch.id} · Páginas ${batch.first_page}–${batch.last_page}${overlapNote}\n\n${blocks}\n\n--- FIM DO MATERIAL ---\n\nConverta agora seguindo rigorosamente todas as instruções do prompt.`;
}

/**
 * Pipeline streaming: OCR (Python) e LLM (Node) rodam concorrentemente.
 * Assim que BATCH_SIZE páginas terminam OCR, dispara LLM em paralelo
 * enquanto OCR continua nas próximas.
 */
export async function runStreaming({ rawDir, batchesDir, outDir, promptPath, state, pythonBin, ocrScript }) {
  fs.mkdirSync(batchesDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  const manifest = JSON.parse(fs.readFileSync(path.join(rawDir, 'manifest.json'), 'utf8'));
  const all = manifest;
  const batchSize = parseInt(process.env.BATCH_SIZE || '5', 10);
  const overlap = parseInt(process.env.BATCH_OVERLAP || '1', 10);
  const stride = Math.max(1, batchSize - overlap);

  // Plano fixo de lotes
  const plans = [];
  for (let s = 0; s < all.length; s += stride) {
    const slice = all.slice(s, s + batchSize);
    if (slice.length === 0) break;
    plans.push({
      id: `batch-${String(plans.length + 1).padStart(3, '0')}`,
      first_page: slice[0].page,
      last_page: slice[slice.length - 1].page,
      overlap_pages: s === 0 ? [] : slice.slice(0, overlap).map(p => p.page),
      manifest_pages: slice,
    });
    if (s + batchSize >= all.length) break;
  }
  state.data.totals.batches = plans.length;
  state.data.stages.convert.batchesTotal = plans.length;
  state.save();

  log.info(`stream: ${all.length} págs → ${plans.length} lotes (size=${batchSize}, overlap=${overlap})`);

  // Spawn OCR (Python) em background
  log.step(`stream: iniciando OCR em background`);
  const ocrProc = spawn(pythonBin, [ocrScript, rawDir], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    shell: false,
  });
  let ocrExitCode = null;
  ocrProc.on('exit', code => { ocrExitCode = code; });

  // Loop: espera lote pronto e converte
  const completedBatches = new Set(state.data.stages.convert.batchesDone || []);
  const inflightLLMs = [];
  const maxInflight = parseInt(process.env.LLM_MAX_INFLIGHT || '1', 10);

  for (const plan of plans) {
    if (completedBatches.has(plan.id) && fs.existsSync(path.join(outDir, `${plan.id}.md`))) {
      log.info(`stream: ${plan.id} já feito, pulando`);
      continue;
    }

    // Espera todas as páginas do lote terem .txt
    while (true) {
      const ready = plan.manifest_pages.every(m => {
        const txt = path.join(rawDir, `page-${String(m.page).padStart(3, '0')}.txt`);
        return fs.existsSync(txt);
      });
      if (ready) break;
      if (ocrExitCode !== null && ocrExitCode !== 0) {
        throw new Error(`OCR falhou com código ${ocrExitCode}`);
      }
      if (ocrExitCode === 0) {
        // Encerrou mas página faltando: erro
        const missing = plan.manifest_pages.find(m => {
          const txt = path.join(rawDir, `page-${String(m.page).padStart(3, '0')}.txt`);
          return !fs.existsSync(txt);
        });
        if (missing) throw new Error(`OCR encerrou mas pág ${missing.page} sem texto`);
        break;
      }
      await sleep(1500);
    }

    // Lê os textos atualizados das páginas
    const fullPages = plan.manifest_pages.map(m => {
      const txtFile = path.join(rawDir, `page-${String(m.page).padStart(3, '0')}.txt`);
      const text = fs.existsSync(txtFile) ? fs.readFileSync(txtFile, 'utf8') : '';
      return {
        page: m.page,
        type: m.type,
        text,
        image: m.image,
        figures: m.figures || [],
        needs_vision: false,  // streaming desativa vision escalation
        ocr_confidence: m.ocr_confidence ?? null,
        text_source: m.text_source || 'streaming',
      };
    });

    const batch = {
      id: plan.id,
      first_page: plan.first_page,
      last_page: plan.last_page,
      overlap_pages: plan.overlap_pages,
      needs_vision: false,
      pages: fullPages,
    };
    writeFileSyncDurable(path.join(batchesDir, `${plan.id}.json`), JSON.stringify(batch, null, 2));

    // Limita LLMs em paralelo (rate-limit Gemini)
    while (inflightLLMs.length >= maxInflight) {
      await Promise.race(inflightLLMs);
    }

    state.data.currentBatch = plan.id;
    state.save();

    log.step(`stream: ${plan.id} OCR pronto → enviando ao LLM (págs ${plan.first_page}–${plan.last_page})`);
    const t0 = Date.now();
    const job = callLLM(buildBatchPrompt(promptPath, batch), { images: [] })
      .then(result => {
        const dt = ((Date.now() - t0) / 1000).toFixed(1);
        writeFileSyncDurable(path.join(outDir, `${plan.id}.md`), result.text);
        state.recordBatch(plan.id, true);
        state.recordLLM(result.provider, result.fallback);
        state.data.lastMarkdownPreview = {
          batch: plan.id,
          provider: result.provider,
          pages: `${plan.first_page}-${plan.last_page}`,
          seconds: parseFloat(dt),
          preview: result.text.slice(0, 4000),
          length: result.text.length,
          at: new Date().toISOString(),
        };
        state.save();
        log.ok(`stream: ${plan.id} LLM ok via ${result.provider} em ${dt}s`);
      })
      .catch(e => {
        log.err(`stream: ${plan.id} LLM falhou: ${e.message}`);
        throw e;
      })
      .finally(() => {
        const idx = inflightLLMs.indexOf(job);
        if (idx >= 0) inflightLLMs.splice(idx, 1);
      });
    inflightLLMs.push(job);
  }

  log.info('stream: aguardando OCR e LLMs restantes…');
  await Promise.all(inflightLLMs);
  if (ocrExitCode === null) {
    await new Promise(resolve => ocrProc.on('exit', resolve));
  }
  if (ocrExitCode !== null && ocrExitCode !== 0) {
    throw new Error(`OCR final exit ${ocrExitCode}`);
  }
  state.data.currentBatch = null;
  state.save();
}
