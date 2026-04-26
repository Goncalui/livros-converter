import fs from 'node:fs';

const HOST = () => process.env.OLLAMA_HOST || 'http://localhost:11434';

export async function callOllama(prompt, { images = [], model } = {}) {
  const m = model || (images.length
    ? (process.env.OLLAMA_VISION_MODEL || 'llava:13b')
    : (process.env.OLLAMA_TEXT_MODEL   || 'llama3.1:8b'));

  const body = {
    model: m,
    prompt,
    stream: false,
    options: { temperature: 0.2, num_ctx: 8192 },
  };
  if (images.length) {
    body.images = images.map(p => fs.readFileSync(p).toString('base64'));
  }

  const res = await fetch(`${HOST()}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`ollama HTTP ${res.status}: ${t.slice(0, 300)}`);
  }
  const json = await res.json();
  if (!json?.response) throw new Error('ollama: resposta vazia');
  return json.response.trim();
}

export const ollama = { call: callOllama, name: 'ollama', supportsVision: true };
