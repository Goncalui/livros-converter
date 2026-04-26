import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
export const WORKSPACE_ROOT = path.join(PROJECT_ROOT, 'workspace');
export const PROMPT_PATH = path.resolve(PROJECT_ROOT, '..', 'prompt-conversao-livros.md');

export function workspaceFor(slug) {
  const base = path.join(WORKSPACE_ROOT, slug);
  return {
    base,
    raw: path.join(base, 'raw'),
    batches: path.join(base, 'batches'),
    output: path.join(base, 'output'),
    assets: path.join(base, 'output', 'assets'),
    state: path.join(base, '.state.json'),
    log: path.join(base, 'pipeline.log'),
  };
}

export function slugify(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
