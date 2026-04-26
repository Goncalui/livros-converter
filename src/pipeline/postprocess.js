import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { log } from '../util/log.js';
import { slugify } from '../util/paths.js';

/**
 * Concatena batch-NNN.md em ordem, deduplica páginas que apareceram em overlap
 * (heurística: marcadores `<!-- Página N -->` repetidos consecutivos),
 * divide por capítulos (`### Capítulo`), valida e gera index.md.
 */
export function postprocess({ outDir, batchesDir, slug }) {
  const batchFiles = fs.readdirSync(outDir)
    .filter(f => /^batch-\d+\.md$/.test(f))
    .sort();

  if (batchFiles.length === 0) {
    log.warn('postprocess: nenhum batch convertido');
    return { chapters: 0 };
  }

  // 1. concatena
  let merged = '';
  const seenPages = new Set();
  for (const f of batchFiles) {
    let chunk = fs.readFileSync(path.join(outDir, f), 'utf8');
    // Remove fences ```markdown ... ``` que o LLM às vezes envolve
    chunk = chunk.replace(/^```(?:markdown|md)?\s*\n/, '').replace(/\n```\s*$/, '');
    // Dedup grosseiro: se um marcador de página já apareceu, pula até o próximo
    chunk = stripDuplicatePageMarkers(chunk, seenPages);
    merged += '\n\n' + chunk.trim();
  }

  const fullPath = path.join(outDir, '_full.md');
  fs.writeFileSync(fullPath, merged.trim() + '\n');

  // 2. extrai metadados YAML do primeiro bloco
  let frontmatter = {};
  const fmMatch = merged.match(/^\s*---\n([\s\S]+?)\n---\n/);
  if (fmMatch) {
    try { frontmatter = YAML.parse(fmMatch[1]) || {}; } catch (e) { log.warn(`yaml inválido: ${e.message}`); }
  }

  // 3. divide por capítulos: `### Capítulo` ou `### N.` no nível 3
  const chapters = splitByChapter(merged, frontmatter);

  // 4. salva capítulos
  const chapterFiles = [];
  chapters.forEach((ch, idx) => {
    const num = String(idx + 1).padStart(2, '0');
    const titleSlug = slugify(ch.title || `cap-${num}`);
    const fname = `cap-${num}-${titleSlug}.md`;
    const fm = { ...frontmatter, capitulo: ch.title || frontmatter.capitulo, paginas_origem: ch.pages || frontmatter.paginas_origem };
    const out = `---\n${YAML.stringify(fm)}---\n\n${ch.body.trim()}\n`;
    fs.writeFileSync(path.join(outDir, fname), out);
    chapterFiles.push({ file: fname, title: ch.title, pages: ch.pages });
  });

  // 5. validação rápida
  const issues = validateAll(outDir, chapterFiles);
  fs.writeFileSync(path.join(outDir, '_validation.json'), JSON.stringify(issues, null, 2));

  // 6. index.md
  const index = buildIndex(slug, frontmatter, chapterFiles, issues);
  fs.writeFileSync(path.join(outDir, 'index.md'), index);

  log.ok(`postprocess: ${chapterFiles.length} capítulos, ${issues.length} avisos de validação`);
  return { chapters: chapterFiles.length, issues: issues.length };
}

function stripDuplicatePageMarkers(chunk, seen) {
  const lines = chunk.split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const m = line.match(/^<!--\s*Páginas?\s+([\d–—\-,\s]+)/i);
    if (m) {
      const id = m[1].trim();
      if (seen.has(id)) { skipping = true; continue; }
      seen.add(id);
      skipping = false;
    }
    if (!skipping) out.push(line);
  }
  return out.join('\n');
}

function splitByChapter(md, fm) {
  // Só divide em headings que CLARAMENTE são capítulo/unidade.
  // Aceita: "### Capítulo 3 — Foo", "### Unidade 2 — Bar", "## Capítulo X".
  // Rejeita: "### 1.", "### Questão 5", "### Hipócrates", "### Aristóteles".
  const re = /^#{2,3}\s+(?:Cap[íi]tulo|Unidade)\s+([^\n]+)$/gim;
  const matches = [];
  let m;
  while ((m = re.exec(md)) !== null) matches.push({ index: m.index, title: m[1].trim(), full: m[0] });

  if (matches.length === 0) {
    // Fallback: tudo num único capítulo
    return [{ title: fm.titulo_capitulo || fm.capitulo || 'Conteúdo', body: md, pages: fm.paginas_origem }];
  }

  // Remove frontmatter da primeira parte
  const fmEnd = md.match(/^\s*---\n[\s\S]+?\n---\n/);
  const startBody = fmEnd ? fmEnd[0].length : 0;

  // Extrai chave de identificação ("capítulo 1", "unidade A") de cada match
  const keyOf = full => {
    const m = full.match(/(Cap[íi]tulo|Unidade)\s+(\S+?)(?:\s*[—\-–:]|\s*$)/i);
    return m ? `${m[1].toLowerCase()}-${m[2].toLowerCase()}` : null;
  };

  // Agrupa matches consecutivos com mesma chave (LLM repetiu o heading entre batches)
  const groups = [];
  let cur = null;
  for (const m of matches) {
    const key = keyOf(m.full) || m.title;
    if (cur && cur.key === key) {
      // mantém title mais informativo (mais longo)
      if (m.title.length > cur.title.length) cur.title = m.title;
      continue;
    }
    cur = { key, title: m.title, index: m.index };
    groups.push(cur);
  }

  const chapters = [];
  for (let i = 0; i < groups.length; i++) {
    const a = groups[i].index;
    const b = i + 1 < groups.length ? groups[i + 1].index : md.length;
    const body = md.slice(Math.max(a, startBody), b);
    const pages = inferPagesFromBody(body);
    chapters.push({ title: groups[i].title, body, pages });
  }
  return chapters;
}

function inferPagesFromBody(body) {
  const nums = [...body.matchAll(/<!--\s*Páginas?\s+(\d+)/gi)].map(m => parseInt(m[1], 10));
  if (nums.length === 0) return null;
  return `${Math.min(...nums)}-${Math.max(...nums)}`;
}

function validateAll(outDir, chapterFiles) {
  const issues = [];
  const allIds = new Map(); // id -> [files]
  for (const cf of chapterFiles) {
    const full = fs.readFileSync(path.join(outDir, cf.file), 'utf8');

    // YAML
    const fm = full.match(/^---\n([\s\S]+?)\n---/);
    if (fm) {
      try { YAML.parse(fm[1]); }
      catch (e) { issues.push({ file: cf.file, kind: 'yaml', msg: e.message }); }
    } else {
      issues.push({ file: cf.file, kind: 'yaml', msg: 'sem frontmatter' });
    }

    // $$ pares
    const dd = (full.match(/\$\$/g) || []).length;
    if (dd % 2 !== 0) issues.push({ file: cf.file, kind: 'latex', msg: `$$ ímpares: ${dd}` });

    // IDs
    for (const m of full.matchAll(/<a id="([^"]+)"><\/a>/g)) {
      const id = m[1];
      if (!allIds.has(id)) allIds.set(id, []);
      allIds.get(id).push(cf.file);
    }

    // ilegível
    const ileg = (full.match(/\[TRECHO ILEGÍVEL\]/g) || []).length;
    if (ileg > 0) issues.push({ file: cf.file, kind: 'ilegivel', msg: `${ileg} trecho(s) ilegível(eis)` });
  }
  for (const [id, files] of allIds) {
    if (files.length > 1) issues.push({ file: files.join(', '), kind: 'id-duplicado', msg: id });
  }
  return issues;
}

function buildIndex(slug, fm, chapterFiles, issues) {
  const lines = [];
  lines.push(`# ${fm.livro || slug}\n`);
  if (fm.disciplina) lines.push(`**Disciplina:** ${fm.disciplina}  `);
  if (fm.editora) lines.push(`**Editora:** ${fm.editora}  `);
  if (fm.autor) lines.push(`**Autor:** ${fm.autor}  `);
  if (fm.ano_publicacao) lines.push(`**Ano:** ${fm.ano_publicacao}  `);
  lines.push('');
  lines.push(`## Capítulos\n`);
  chapterFiles.forEach((c, i) => {
    lines.push(`${i + 1}. [${c.title || c.file}](./${c.file})${c.pages ? ` — pp. ${c.pages}` : ''}`);
  });
  lines.push('');
  lines.push(`## Validação\n`);
  lines.push(`- Avisos: ${issues.length}`);
  if (issues.length) {
    lines.push('');
    lines.push('| Arquivo | Tipo | Detalhe |');
    lines.push('|---|---|---|');
    for (const it of issues.slice(0, 50)) {
      lines.push(`| ${it.file} | ${it.kind} | ${String(it.msg).replace(/\|/g, '\\|')} |`);
    }
  }
  return lines.join('\n') + '\n';
}
