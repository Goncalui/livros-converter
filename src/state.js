import fs from 'node:fs';
import path from 'node:path';

const DEFAULT = {
  slug: null,
  input: null,
  createdAt: null,
  updatedAt: null,
  stages: {
    classify:    { status: 'pending', startedAt: null, finishedAt: null, error: null },
    extract:     { status: 'pending', startedAt: null, finishedAt: null, error: null },
    estimate:    { status: 'pending', startedAt: null, finishedAt: null, error: null },
    batch:       { status: 'pending', startedAt: null, finishedAt: null, error: null },
    convert:     { status: 'pending', startedAt: null, finishedAt: null, error: null,
                   batchesDone: [], batchesTotal: 0 },
    postprocess: { status: 'pending', startedAt: null, finishedAt: null, error: null },
  },
  totals: { pages: 0, native: 0, scanned: 0, batches: 0, chapters: 0 },
  estimate: null,
  currentBatch: null,
  lastMarkdownPreview: null,
  llmStats: { calls: 0, byProvider: {}, fallbacks: 0 },
};

export class State {
  constructor(filepath) {
    this.path = filepath;
    if (fs.existsSync(filepath)) {
      this.data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    } else {
      this.data = structuredClone(DEFAULT);
      this.data.createdAt = new Date().toISOString();
    }
  }

  save() {
    this.data.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2));
  }

  startStage(name) {
    const s = this.data.stages[name];
    s.status = 'in_progress';
    s.startedAt = new Date().toISOString();
    s.error = null;
    this.save();
  }

  finishStage(name) {
    const s = this.data.stages[name];
    s.status = 'completed';
    s.finishedAt = new Date().toISOString();
    this.save();
  }

  failStage(name, err) {
    const s = this.data.stages[name];
    s.status = 'failed';
    s.error = err?.message || String(err);
    this.save();
  }

  recordBatch(batchId, ok = true) {
    const c = this.data.stages.convert;
    if (ok) c.batchesDone = Array.from(new Set([...c.batchesDone, batchId])).sort();
    this.save();
  }

  recordLLM(provider, fallback = false) {
    this.data.llmStats.calls++;
    this.data.llmStats.byProvider[provider] = (this.data.llmStats.byProvider[provider] || 0) + 1;
    if (fallback) this.data.llmStats.fallbacks++;
    this.save();
  }
}
