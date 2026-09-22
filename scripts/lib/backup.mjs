import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const safeStamp = stamp => {
  if (!/^[A-Za-z0-9-]+$/.test(stamp)) throw new Error(`invalid backup stamp: ${stamp}`);
  return stamp;
};
const backupDir = (outDir, stamp) => path.join(outDir, 'backups', safeStamp(stamp));
const json = p => JSON.parse(fs.readFileSync(p, 'utf8'));

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function fingerprint(file) {
  if (!fs.existsSync(file)) return { kind: 'missing' };
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) return { kind: 'symlink', target: fs.readlinkSync(file) };
  if (stat.isFile()) return { kind: 'file', sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
  return { kind: 'other', size: stat.size, mtimeMs: stat.mtimeMs };
}

const sameFingerprint = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function createBackup(outDir, stamp) {
  const dir = backupDir(outDir, stamp);
  const journalPath = path.join(dir, 'journal.json');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try { fs.mkdirSync(dir); }
  catch (e) {
    if (e.code === 'EEXIST') throw new Error(`backup already exists: ${dir}`);
    throw e;
  }
  const entries = [];
  const createdAt = Date.now();
  const journal = () => ({ stamp, createdAt, entries });
  const persist = () => writeJsonAtomic(journalPath, journal());
  const store = (original, mode) => {
    const previous = entries.find(e => e.original === original);
    if (previous && !previous.captured) throw new Error(`backup capture did not complete: ${original}`);
    if (!fs.existsSync(original) || previous) return false;
    const entry = {
      original,
      stored: path.join(dir, `entry-${entries.length}`),
      mode,
      before: fingerprint(original),
      captured: false,
      applied: null,
    };
    entries.push(entry);
    persist(); // Persist recovery intent before an operation can move the original.
    if (mode === 'copy') fs.cpSync(original, entry.stored, { recursive: true });
    else fs.renameSync(original, entry.stored);
    entry.captured = true;
    persist();
    return true;
  };
  return {
    dir,
    add: p => store(p, 'copy'),
    move: p => {
      const moved = store(p, 'move');
      if (moved) {
        const entry = entries.find(e => e.original === p);
        entry.applied = { kind: 'missing' };
        persist();
      }
      return moved;
    },
    markApplied: p => {
      const entry = entries.find(e => e.original === p);
      if (!entry) throw new Error(`backup missing entry for changed path: ${p}`);
      entry.applied = fingerprint(p);
      persist();
    },
    finish: () => {
      if (entries.length === 0) return null;
      writeJsonAtomic(path.join(dir, 'manifest.json'), { ...journal(), finishedAt: Date.now() });
      fs.rmSync(journalPath, { force: true });
      return dir;
    },
  };
}

export function listBackups(outDir) {
  const root = path.join(outDir, 'backups');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .flatMap(s => {
      const dir = path.join(root, s);
      const manifest = path.join(dir, 'manifest.json');
      const journal = path.join(dir, 'journal.json');
      if (fs.existsSync(manifest)) return [json(manifest)];
      if (fs.existsSync(journal)) return [{ ...json(journal), incomplete: true }];
      return [];
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function restoreBackup(outDir, stamp, { force = false } = {}) {
  const dir = backupDir(outDir, stamp);
  const manifestPath = path.join(dir, 'manifest.json');
  const journalPath = path.join(dir, 'journal.json');
  if (!fs.existsSync(manifestPath) && !fs.existsSync(journalPath)) throw new Error(`no backup with stamp ${stamp}`);
  const { entries } = json(fs.existsSync(manifestPath) ? manifestPath : journalPath);
  const restored = [], conflicts = [], failed = [];
  for (const e of entries) {
    try {
      const originalExists = fs.existsSync(e.original);
      const storedExists = fs.existsSync(e.stored);
      if (e.captured === false && !(e.mode === 'move' && !originalExists && storedExists)) {
        if (e.mode === 'move' && originalExists && !storedExists) continue;
        failed.push({ original: e.original, reason: 'backup capture was interrupted' });
        continue;
      }
      if (!storedExists) {
        failed.push({ original: e.original, reason: `backup copy missing: ${e.stored}` });
        continue;
      }
      if (!force && e.mode === 'move' && originalExists) { conflicts.push(e.original); continue; }
      if (!force && e.mode === 'copy' && !originalExists) { conflicts.push(e.original); continue; }
      if (!force && e.mode === 'copy' && originalExists && (!e.applied || !sameFingerprint(fingerprint(e.original), e.applied))) { conflicts.push(e.original); continue; }
      fs.mkdirSync(path.dirname(e.original), { recursive: true });
      if (e.mode === 'copy') {
        const temp = path.join(path.dirname(e.original), `.${path.basename(e.original)}.harness-audit-restore-${crypto.randomUUID()}`);
        try {
          fs.cpSync(e.stored, temp, { recursive: true });
          if (fs.existsSync(e.original)) fs.rmSync(e.original, { recursive: true, force: true });
          fs.renameSync(temp, e.original);
        } finally {
          fs.rmSync(temp, { recursive: true, force: true });
        }
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
