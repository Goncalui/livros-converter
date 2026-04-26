import fs from 'node:fs';
import path from 'node:path';

const colors = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  blue: '\x1b[34m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

let logFile = null;

export function setLogFile(p) {
  logFile = p;
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function write(level, color, parts) {
  const ts = new Date().toISOString().slice(11, 19);
  const msg = parts.map(p => typeof p === 'string' ? p : JSON.stringify(p)).join(' ');
  process.stdout.write(`${colors.gray}${ts}${colors.reset} ${color}${level}${colors.reset} ${msg}\n`);
  if (logFile) {
    try { fs.appendFileSync(logFile, `${ts} ${level} ${msg}\n`); } catch {}
  }
}

export const log = {
  info: (...a) => write('INFO ', colors.blue, a),
  ok:   (...a) => write('OK   ', colors.green, a),
  warn: (...a) => write('WARN ', colors.yellow, a),
  err:  (...a) => write('ERR  ', colors.red, a),
  step: (...a) => write('STEP ', colors.blue, a),
};
