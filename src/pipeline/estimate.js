import fs from 'node:fs';
import path from 'node:path';
import { log } from '../util/log.js';

/**
 * Estima tokens e custo aproximado.
 * Heurística: 1 token ≈ 4 caracteres em pt-BR; prompt-base ~ 8k tokens.
 * Custos referência (USD/Mtok) — atualize se mudar:
 *   gemini-2.5-pro:  in $1.25 / out $5
 *   claude (CLI):    sem custo direto (consome sub)
 *   ollama:          0 (local)
 */
const PROMPT_OVERHEAD_TOK = 8000;
const RATES = {
  'gemini-2.5-pro': { in: 1.25, out: 5.0 },
};

export function estimate(rawDir, batchesDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(rawDir, 'manifest.json'), 'utf8'));
  let totalChars = 0;
  let visionPages = 0;
  for (const m of manifest) {
    if (m.text_file) {
      try { totalChars += fs.statSync(path.join(rawDir, m.text_file)).size; } catch {}
    }
    if (m.needs_vision) visionPages++;
  }
  const inputTok = Math.ceil(totalChars / 4);
  const batchSize = parseInt(process.env.BATCH_SIZE || '5', 10);
  const overlap = parseInt(process.env.BATCH_OVERLAP || '1', 10);
  const stride = Math.max(1, batchSize - overlap);
  const numBatches = Math.ceil(manifest.length / stride);
  const promptInputTok = inputTok + numBatches * PROMPT_OVERHEAD_TOK;
  const outputTok = Math.ceil(inputTok * 1.4); // markdown estruturado costuma crescer ~40%

  const gem = RATES['gemini-2.5-pro'];
  const visionFraction = visionPages / Math.max(1, manifest.length);
  const geminiUsd = (promptInputTok * gem.in + outputTok * gem.out) / 1e6 * visionFraction;

  const summary = {
    pages: manifest.length,
    visionPages,
    visionFraction: +(visionFraction * 100).toFixed(1) + '%',
    batches: numBatches,
    inputTokensApprox: promptInputTok,
    outputTokensApprox: outputTok,
    estimatedCostUsd: {
      claudeCli: 0,
      gemini: +geminiUsd.toFixed(2),
      ollama: 0,
      note: 'Claude CLI consome sua assinatura. Gemini só é usado em páginas com OCR ruim ou visão.',
    },
  };
  log.info('estimativa:', JSON.stringify(summary, null, 2));
  return summary;
}
