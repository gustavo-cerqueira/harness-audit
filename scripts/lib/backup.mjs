// scripts/lib/backup.mjs
import fs from 'node:fs';
import path from 'node:path';

const encode = p => p.replace(/[\/\\:]/g, '__');

export function createBackup(outDir, stamp) {
  const dir = path.join(outDir, 'backups', stamp);
  const entries = [];
  const createdAt = Date.now();
  const store = (original, mode) => {
    if (!fs.existsSync(original) || entries.some(e => e.original === original)) return;
    fs.mkdirSync(dir, { recursive: true });
    const stored = path.join(dir, encode(original));
    const mtimeMs = fs.statSync(original).mtimeMs;
    if (mode === 'copy') fs.cpSync(original, stored, { recursive: true });
    else fs.renameSync(original, stored);
    entries.push({ original, stored, mode, mtimeMs });
  };
  return {
    dir,
    add: p => store(p, 'copy'),
    move: p => store(p, 'move'),
    finish: () => {
      if (entries.length === 0) return null;
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ stamp, createdAt, finishedAt: Date.now(), entries }, null, 2) + '\n');
      return dir;
    },
  };
}

export function listBackups(outDir) {
  const root = path.join(outDir, 'backups');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter(s => fs.existsSync(path.join(root, s, 'manifest.json')))
    .map(s => JSON.parse(fs.readFileSync(path.join(root, s, 'manifest.json'), 'utf8')))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function restoreBackup(outDir, stamp, { force = false } = {}) {
  const manifestPath = path.join(outDir, 'backups', stamp, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`no backup with stamp ${stamp}`);
  const { finishedAt, entries } = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const restored = [], conflicts = [], failed = [];
  for (const e of entries) {
    try {
      if (!force && fs.existsSync(e.original) && (e.mode === 'move' || fs.statSync(e.original).mtimeMs > finishedAt + 1000)) { conflicts.push(e.original); continue; }
      if (!fs.existsSync(e.stored)) { failed.push({ original: e.original, reason: `backup copy missing: ${e.stored}` }); continue; }
      fs.mkdirSync(path.dirname(e.original), { recursive: true });
      if (e.mode === 'copy') {
        // ponytail: restore-then-swap so a failed copy never leaves `original` deleted with nothing to replace it.
        const temp = e.original + '.harness-audit-restore';
        fs.rmSync(temp, { recursive: true, force: true });
        fs.cpSync(e.stored, temp, { recursive: true });
        if (fs.existsSync(e.original)) fs.rmSync(e.original, { recursive: true, force: true });
        fs.renameSync(temp, e.original);
      } else {
        if (fs.existsSync(e.original)) fs.rmSync(e.original, { recursive: true, force: true });
        fs.renameSync(e.stored, e.original);
      }
      restored.push(e.original);
    } catch (err) {
      failed.push({ original: e.original, reason: err.message });
    }
  }
  return { restored, conflicts, failed };
}
