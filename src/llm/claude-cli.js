import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/**
 * Claude CLI em modo print (-p). Suporta visão: caminhos absolutos de imagens
 * incluídos no prompt são automaticamente anexados pelo CLI.
 */
export async function callClaudeCLI(prompt, { images = [], timeoutMs = 900000 } = {}) {
  const bin = process.env.CLAUDE_CLI_BIN || 'claude';
  const isWin = os.platform() === 'win32';
  const args = ['-p'];
  if (process.env.CLAUDE_CLI_MODEL) args.push('--model', process.env.CLAUDE_CLI_MODEL);

  let fullPrompt = prompt;
  if (images.length) {
    const list = images.map(p => path.resolve(p)).join('\n');
    fullPrompt = `${prompt}\n\nIMAGENS DA PÁGINA (caminhos locais — abra cada uma e leia diretamente):\n${list}\n`;
  }

  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isWin,
    });
    let out = '', err = '';
    let timed = false;
    const timer = setTimeout(() => { timed = true; try { p.kill(); } catch {} }, timeoutMs);

    p.stdout.on('data', d => { out += d.toString('utf8'); });
    p.stderr.on('data', d => { err += d.toString('utf8'); });
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer);
      if (timed) return reject(new Error('claude-cli: timeout'));
      if (code !== 0) return reject(new Error(`claude-cli exit ${code}: ${err.slice(0, 500)}`));
      resolve(out.trim());
    });

    p.stdin.write(fullPrompt);
    p.stdin.end();
  });
}

export const claudeCli = { call: callClaudeCLI, name: 'claude-cli', supportsVision: true };
