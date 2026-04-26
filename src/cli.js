#!/usr/bin/env node
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { runFull, makeSlug } from './orchestrator.js';
import { workspaceFor, WORKSPACE_ROOT } from './util/paths.js';
import { startServer } from './server.js';
import { log } from './util/log.js';

const [, , cmd, ...rest] = process.argv;

function usage() {
  console.log(`
livros — conversor de livros didáticos para Markdown/RAG

Comandos:
  convert <input>          Pipeline completo (PDF ou pasta de imagens)
  resume <slug>            Retoma a partir do último checkpoint
  ui [port]                Sobe a página de visualização (default 5173)
  status [slug]            Mostra estado de um livro (ou lista todos)
  help                     Esta ajuda

Exemplos:
  node src/cli.js convert ./meulivro.pdf
  node src/cli.js ui 5173
  node src/cli.js status bio-vol1
`);
}

async function cmdConvert(input) {
  if (!input) { console.error('uso: convert <input>'); process.exit(2); }
  if (!fs.existsSync(input)) { console.error(`não existe: ${input}`); process.exit(1); }
  await runFull(input);
}

async function cmdResume(slug) {
  if (!slug) { console.error('uso: resume <slug>'); process.exit(2); }
  const ws = workspaceFor(slug);
  if (!fs.existsSync(ws.state)) { console.error(`sem estado para ${slug}`); process.exit(1); }
  const st = JSON.parse(fs.readFileSync(ws.state, 'utf8'));
  if (!st.input) { console.error('estado sem caminho de input'); process.exit(1); }
  await runFull(st.input, { slug });
}

function cmdStatus(slug) {
  if (!slug) {
    if (!fs.existsSync(WORKSPACE_ROOT)) { console.log('(sem livros)'); return; }
    const slugs = fs.readdirSync(WORKSPACE_ROOT).filter(s =>
      fs.existsSync(path.join(WORKSPACE_ROOT, s, '.state.json')));
    if (!slugs.length) { console.log('(sem livros)'); return; }
    for (const s of slugs) {
      const st = JSON.parse(fs.readFileSync(path.join(WORKSPACE_ROOT, s, '.state.json'), 'utf8'));
      const stages = Object.entries(st.stages).map(([k, v]) => `${k}=${v.status}`).join(' ');
      console.log(`${s}: ${stages}`);
    }
    return;
  }
  const ws = workspaceFor(slug);
  if (!fs.existsSync(ws.state)) { console.error(`sem estado para ${slug}`); return; }
  console.log(fs.readFileSync(ws.state, 'utf8'));
}

async function main() {
  switch (cmd) {
    case 'convert':    return cmdConvert(rest[0]);
    case 'resume':     return cmdResume(rest[0]);
    case 'ui':         return startServer(parseInt(rest[0] || '5173', 10));
    case 'status':     return cmdStatus(rest[0]);
    case 'help': case undefined: case '-h': case '--help': return usage();
    default:
      console.error(`comando desconhecido: ${cmd}`);
      usage();
      process.exit(2);
  }
}

main().catch(e => {
  log.err(e.stack || e.message);
  process.exit(1);
});
