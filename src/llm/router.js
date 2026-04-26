import { claudeCli } from './claude-cli.js';
import { gemini } from './gemini.js';
import { ollama } from './ollama.js';
import { log } from '../util/log.js';

const PROVIDERS = { 'claude-cli': claudeCli, gemini, ollama };

function order(needsVision) {
  const env = needsVision ? process.env.LLM_ORDER_VISION : process.env.LLM_ORDER_TEXT;
  const def = needsVision ? 'gemini,ollama' : 'claude-cli,gemini,ollama';
  return (env || def).split(',').map(s => s.trim()).filter(Boolean);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Tenta providers em ordem com 2 retries por provider (backoff).
 * Se needsVision, pula providers sem suporte.
 * Retorna { text, provider, fallback }.
 */
export async function callLLM(prompt, { images = [], onAttempt } = {}) {
  const needsVision = images.length > 0;
  const seq = order(needsVision);
  let firstChoice = null;
  let lastErr = null;

  for (const name of seq) {
    const p = PROVIDERS[name];
    if (!p) { log.warn(`router: provider desconhecido "${name}"`); continue; }
    if (needsVision && !p.supportsVision) continue;
    if (!firstChoice) firstChoice = name;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        onAttempt?.({ provider: name, attempt });
        const text = await p.call(prompt, { images });
        return { text, provider: name, fallback: name !== firstChoice };
      } catch (e) {
        lastErr = e;
        log.warn(`router: ${name} tentativa ${attempt} falhou: ${e.message}`);
        if (attempt < 2) await sleep(1500 * attempt);
      }
    }
  }
  throw new Error(`todos providers falharam: ${lastErr?.message || 'sem detalhes'}`);
}
