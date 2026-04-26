import fs from 'node:fs';

/**
 * Escreve o arquivo e força fsync. Essencial em Drive FUSE (Colab),
 * que bufferiza writes sem fsync e perde dados em crash/timeout.
 */
export function writeFileSyncDurable(filepath, data) {
  fs.writeFileSync(filepath, data);
  try {
    const fd = fs.openSync(filepath, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* best-effort */ }
}
