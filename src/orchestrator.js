import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { State } from './state.js';
import { log, setLogFile } from './util/log.js';
import { workspaceFor, slugify, PROMPT_PATH, PROJECT_ROOT } from './util/paths.js';
import { buildBatches } from './pipeline/batch.js';
import { convertBatches } from './pipeline/convert.js';
import { postprocess } from './pipeline/postprocess.js';
import { estimate } from './pipeline/estimate.js';
import { runStreaming } from './pipeline/stream.js';

const PYTHON = () => process.env.PYTHON_BIN || 'python';

function runPython(script, args) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(PROJECT_ROOT, 'src', 'extract', script);
    const p = spawn(PYTHON(), [scriptPath, ...args], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        FLAGS_use_mkldnn: '0',
        FLAGS_enable_pir_in_executor: '0',
      },
      shell: false,
    });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`${script} exit ${code}`)));
  });
}

export function makeSlug(input) {
  const base = path.basename(input).replace(/\.[^.]+$/, '');
  return slugify(base) || 'livro';
}

export async function runFull(input, { slug } = {}) {
  const _slug = slug || makeSlug(input);
  const ws = workspaceFor(_slug);
  fs.mkdirSync(ws.base, { recursive: true });
  setLogFile(ws.log);

  const state = new State(ws.state);
  state.data.slug = _slug;
  state.data.input = path.resolve(input);
  state.save();

  log.step(`livro: ${_slug}`);
  log.info(`workspace: ${ws.base}`);

  // 1. classify
  if (state.data.stages.classify.status !== 'completed') {
    state.startStage('classify');
    try { await runPython('classify.py', [path.resolve(input), ws.raw]); state.finishStage('classify'); }
    catch (e) { state.failStage('classify', e); throw e; }
  } else log.info('classify: pulado (já concluído)');

  const STREAMING = (process.env.LLM_STREAMING ?? '1') !== '0';

  // totals (do manifest atual após classify)
  const manifest = JSON.parse(fs.readFileSync(path.join(ws.raw, 'manifest.json'), 'utf8'));
  state.data.totals.pages = manifest.length;
  state.data.totals.native = manifest.filter(m => m.type === 'nativo').length;
  state.data.totals.scanned = manifest.filter(m => m.type === 'escaneado').length;
  state.save();

  if (STREAMING) {
    log.info('LLM_STREAMING=1 → rodando OCR e LLM em paralelo (a cada lote pronto, dispara LLM)');
    state.startStage('extract');
    state.startStage('convert');
    try {
      await runStreaming({
        rawDir: ws.raw,
        batchesDir: ws.batches,
        outDir: ws.output,
        promptPath: PROMPT_PATH,
        state,
        pythonBin: PYTHON(),
        ocrScript: path.join(PROJECT_ROOT, 'src', 'extract', 'ocr.py'),
      });
      state.finishStage('extract');
      state.finishStage('convert');
    } catch (e) {
      state.failStage('convert', e);
      throw e;
    }
  } else {
    // 2. extract clássico (sequencial)
    if (state.data.stages.extract.status !== 'completed') {
      state.startStage('extract');
      try {
        await runPython('extract_text.py', [ws.raw]);
        await runPython('ocr.py', [ws.raw]);
        await runPython('extract_images.py', [ws.raw]);
        state.finishStage('extract');
      } catch (e) { state.failStage('extract', e); throw e; }
    } else log.info('extract: pulado');

    // 3. estimate
    if (state.data.stages.estimate.status !== 'completed') {
      state.startStage('estimate');
      state.data.estimate = estimate(ws.raw, ws.batches);
      state.finishStage('estimate');
    }

    // 4. batch
    if (state.data.stages.batch.status !== 'completed') {
      state.startStage('batch');
      try {
        const ids = buildBatches(ws.raw, ws.batches);
        state.data.totals.batches = ids.length;
        state.finishStage('batch');
      } catch (e) { state.failStage('batch', e); throw e; }
    } else log.info('batch: pulado');

    // 5. convert
    state.startStage('convert');
    try {
      await convertBatches({
        batchesDir: ws.batches, outDir: ws.output,
        promptPath: PROMPT_PATH, state,
      });
      state.finishStage('convert');
    } catch (e) { state.failStage('convert', e); throw e; }
  }

  // 6. postprocess
  state.startStage('postprocess');
  try {
    const r = postprocess({ outDir: ws.output, batchesDir: ws.batches, slug: _slug });
    state.data.totals.chapters = r.chapters;
    state.finishStage('postprocess');
  } catch (e) { state.failStage('postprocess', e); throw e; }

  log.ok(`pronto: ${ws.output}`);
  return ws;
}
