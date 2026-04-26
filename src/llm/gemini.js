import fs from 'node:fs';
import { GoogleGenAI } from '@google/genai';

let _client = null;
function client() {
  if (_client) return _client;
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY não configurado');
  _client = new GoogleGenAI({ apiKey: key });
  return _client;
}

function mimeFor(p) {
  const ext = p.toLowerCase().split('.').pop();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
           webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp' })[ext]
         || 'image/png';
}

export async function callGemini(prompt, { images = [], model } = {}) {
  const ai = client();
  const m = model || (images.length
    ? (process.env.GEMINI_VISION_MODEL || 'gemini-2.5-pro')
    : (process.env.GEMINI_TEXT_MODEL   || 'gemini-2.5-pro'));

  const parts = [{ text: prompt }];
  for (const img of images) {
    const data = fs.readFileSync(img).toString('base64');
    parts.push({ inlineData: { mimeType: mimeFor(img), data } });
  }

  const res = await ai.models.generateContent({
    model: m,
    contents: [{ role: 'user', parts }],
  });
  const text = res?.text ?? res?.response?.text?.() ?? '';
  if (!text) throw new Error('gemini: resposta vazia');
  return text.trim();
}

export const gemini = { call: callGemini, name: 'gemini', supportsVision: true };
