const $ = sel => document.querySelector(sel);
const sel = $('#bookSelect');
const stagesBox = $('#stages');
const filesBox = $('#files');
const previewBox = $('#preview');
const logBox = $('#logBox');
const conn = $('#conn');
const bar = $('#bar');

let currentSlug = null;
let currentFile = null;
let userPickedFile = false;
let es = null;

async function loadBooks() {
  const r = await fetch('/api/books');
  const list = await r.json();
  sel.innerHTML = '';
  if (list.length === 0) {
    const o = document.createElement('option');
    o.textContent = '(nenhum livro)';
    sel.appendChild(o);
    return;
  }
  for (const s of list) {
    const o = document.createElement('option');
    o.value = s; o.textContent = s;
    sel.appendChild(o);
  }
  if (!currentSlug) currentSlug = list[0];
  sel.value = currentSlug;
  connect(currentSlug);
}

function connect(slug) {
  if (es) es.close();
  currentSlug = slug;
  es = new EventSource(`/api/stream?slug=${encodeURIComponent(slug)}`);
  es.onopen = () => { conn.textContent = 'conectado'; conn.classList.add('pulse'); };
  es.onerror = () => { conn.textContent = 'reconectando…'; conn.classList.remove('pulse'); };
  es.onmessage = ev => {
    try { render(JSON.parse(ev.data)); } catch (e) { console.error(e); }
  };
  refreshLog();
}

function badge(status) {
  return `<span class="badge ${status}">${status}</span>`;
}

const STAGE_LABELS = {
  classify: 'Classificar páginas',
  extract:  'Extrair texto + OCR',
  estimate: 'Estimar custo',
  batch:    'Agrupar em lotes',
  convert:  'Converter (LLM)',
  postprocess: 'Pós-processar',
};

function render({ state, outputs }) {
  if (!state) {
    stagesBox.innerHTML = '<div class="empty">sem dados</div>';
    return;
  }
  $('#updatedAt').textContent = state.updatedAt ? `atualizado ${new Date(state.updatedAt).toLocaleTimeString()}` : '';
  stagesBox.innerHTML = Object.entries(state.stages).map(([k, v]) =>
    `<div class="stage"><span class="name">${STAGE_LABELS[k] || k}</span>${badge(v.status)}</div>`
  ).join('');

  const c = state.stages.convert;
  const done = c.batchesDone?.length || 0;
  const total = c.batchesTotal || 0;
  $('#batchCount').textContent = `${done}/${total}`;
  bar.style.width = total ? `${Math.round(done / total * 100)}%` : '0%';

  const t = state.totals || {};
  $('#pages').textContent = t.pages ?? '—';
  $('#natOcr').textContent = `${t.native ?? 0} / ${t.scanned ?? 0}`;
  $('#chapters').textContent = t.chapters ?? '—';
  const llm = state.llmStats || {};
  $('#llmCalls').textContent = llm.calls ?? 0;
  $('#llmFb').textContent = llm.fallbacks ?? 0;
  $('#byProvider').textContent = Object.entries(llm.byProvider || {})
    .map(([k, v]) => `${k}:${v}`).join(' · ') || '—';

  const est = state.estimate;
  if (est) {
    $('#estimate').innerHTML = `
      <span class="k">Gemini (visão)</span><span>USD ${est.estimatedCostUsd?.gemini ?? 0}</span>
    `;
  }

  filesBox.innerHTML = (outputs || []).map(f =>
    `<button data-file="${f.name}" class="${f.name === currentFile ? 'active' : ''}">${f.name} <span style="color:var(--muted);float:right">${(f.size/1024).toFixed(1)}k</span></button>`
  ).join('') || '<div class="empty">aguardando primeiro lote…</div>';

  // auto-seleciona o último arquivo gerado se usuário ainda não escolheu
  if (!userPickedFile && outputs?.length) {
    const last = outputs[outputs.length - 1].name;
    if (last !== currentFile) loadFile(last, false);
  } else if (state.lastMarkdownPreview && !currentFile) {
    previewBox.textContent = state.lastMarkdownPreview.preview || '';
  }

  filesBox.querySelectorAll('button').forEach(b => {
    b.onclick = () => { userPickedFile = true; loadFile(b.dataset.file, true); };
  });
}

async function loadFile(file, manual) {
  currentFile = file;
  filesBox.querySelectorAll('button').forEach(b =>
    b.classList.toggle('active', b.dataset.file === file));
  const r = await fetch(`/api/output?slug=${encodeURIComponent(currentSlug)}&file=${encodeURIComponent(file)}`);
  previewBox.textContent = await r.text();
  if (manual) previewBox.scrollTop = 0;
}

async function refreshLog() {
  if (!currentSlug) return;
  const r = await fetch(`/api/log?slug=${encodeURIComponent(currentSlug)}`);
  logBox.textContent = await r.text();
  logBox.scrollTop = logBox.scrollHeight;
}

document.querySelectorAll('.tabs button').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    $('#tabPreview').hidden = tab !== 'preview';
    $('#tabCompare').hidden = tab !== 'compare';
    $('#tabLog').hidden = tab !== 'log';
    if (tab === 'log') refreshLog();
    if (tab === 'compare') loadCompareList();
  };
});

async function loadCompareList() {
  if (!currentSlug) return;
  const r = await fetch(`/api/compare-list?slug=${encodeURIComponent(currentSlug)}`);
  const list = await r.json();
  const box = $('#compareList');
  if (!list.length) {
    box.innerHTML = '<div class="empty">nenhuma comparação. defina OCR_MODE=compare e rode a extração.</div>';
    $('#compareSummary').textContent = '';
    return;
  }
  // sumário: vencedores
  const wins = list.reduce((acc, p) => { acc[p.winner || 'none'] = (acc[p.winner || 'none'] || 0) + 1; return acc; }, {});
  $('#compareSummary').textContent = 'Vencedores: ' + Object.entries(wins).map(([k,v]) => `${k}=${v}`).join(' · ');

  box.innerHTML = list.map(p => `
    <button data-page="${p.page}">
      pág ${String(p.page).padStart(3,'0')}
      <span style="float:right;color:var(--muted);font-size:11px">${p.winner || '—'}</span>
    </button>`).join('');
  box.querySelectorAll('button').forEach(b =>
    b.onclick = () => loadComparePage(parseInt(b.dataset.page, 10)));
  if (list.length) loadComparePage(list[0].page);
}

async function loadComparePage(page) {
  $('#compareList').querySelectorAll('button').forEach(b =>
    b.classList.toggle('active', parseInt(b.dataset.page,10) === page));
  const r = await fetch(`/api/compare-page?slug=${encodeURIComponent(currentSlug)}&page=${page}`);
  const j = await r.json();
  const box = $('#compareDetail');
  const engines = j.engines || {};
  const engNames = Object.keys(engines);
  if (!engNames.length) { box.innerHTML = '<div class="empty">sem dados</div>'; return; }

  function panel(name) {
    const e = engines[name] || {};
    const m = e.metrics || e || {};
    const isWinner = j.winner === name;
    const text = e.text || '';
    const rows = ['chars','words','lines','headers','tables','lists','formulas','bold','confidence','weird_ratio','garbled_ratio','score']
      .filter(k => m[k] !== undefined)
      .map(k => `<tr><td>${k}</td><td>${m[k]}</td></tr>`).join('');
    return `
      <div>
        <h3>${name.toUpperCase()} ${isWinner ? '<span class="winner">vencedor</span>' : ''}</h3>
        <table>${rows}</table>
        <pre style="margin-top:10px">${escapeHtml(text).slice(0, 12000)}</pre>
      </div>`;
  }

  const left = `<div>
    <h3>Página ${j.page}</h3>
    ${j.image ? `<img src="${j.image}">` : '<div class="empty">sem imagem</div>'}
    <div style="margin-top:10px;font-size:12px;color:var(--muted)">vencedor: <b style="color:var(--ok)">${j.winner || '—'}</b></div>
  </div>`;

  const panels = ['paddle','glm','tesseract'].filter(n => engines[n]).map(panel).join('');
  box.innerHTML = `<div class="cmp-grid" style="grid-template-columns: 280px ${'1fr '.repeat(engNames.length)}">${left}${panels}</div>`;
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
}

sel.onchange = () => { userPickedFile = false; currentFile = null; connect(sel.value); };

setInterval(refreshLog, 4000);
loadBooks();
setInterval(loadBooks, 10000);
