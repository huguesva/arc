// Small file helpers. Every write is atomic (tmp + rename) so readers never see partial files.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
export const exists = p => fs.existsSync(p);
export const readText = (p, fallback = null) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : fallback);
export const readJson = (p, fallback = null) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback);

export function writeAtomic(p, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(p), {recursive: true});
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data, {mode});
  fs.renameSync(tmp, p);
}

export const writeJson = (p, value) => writeAtomic(p, JSON.stringify(value, null, 2) + '\n');

export function appendJsonl(p, value) {
  fs.mkdirSync(path.dirname(p), {recursive: true});
  fs.appendFileSync(p, JSON.stringify(value) + '\n', {mode: 0o600});
}

export function readJsonl(p) {
  const text = readText(p, '');
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a torn last line is ignored */ }
  }
  return rows;
}

export const listDir = p => (fs.existsSync(p) ? fs.readdirSync(p).sort() : []);
export const shellQuote = s => `'${String(s).replaceAll("'", "'\\''")}'`;
export const isoNow = (ms = Date.now()) => new Date(ms).toISOString();
