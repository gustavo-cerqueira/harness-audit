import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Metadata includes inode and nanosecond change time, so replacing or editing a file
// invalidates approval without reading multi-gigabyte plugin caches into memory.
// Symlinks are fingerprinted as links, never recursively followed.
export function targetSnapshot(target) {
  const hash = crypto.createHash('sha256');
  const visit = (file, relative) => {
    const stat = fs.lstatSync(file, { bigint: true });
    hash.update(JSON.stringify([relative, ...['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].map(k => String(stat[k]))]));
    if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(file));
    else if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), path.join(relative, name));
  };
  visit(target, '');
  return hash.digest('hex');
}

export function snapshotTargets(claude, codex, warnings) {
  const paths = new Set();
  for (const section of [claude, codex].filter(Boolean)) {
    for (const s of section.skills) paths.add(path.dirname(s.path));
    for (const a of section.agents) paths.add(a.path);
    for (const p of section.plugins ?? []) if (p.enabledPath) paths.add(p.enabledPath);
    for (const s of section.mcpServers) if (s.path) paths.add(s.path);
    for (const hooks of Object.values(section.hooks)) for (const h of hooks) if (h.path) paths.add(h.path);
    for (const c of section.clutter) if (c.kind !== 'dead-project-entry') paths.add(c.path);
  }
  if (codex?.clutter.some(c => c.kind === 'dead-project-entry')) paths.add(path.join(codex.root, 'config.toml'));
  const snapshots = {};
  for (const p of paths) {
    try { snapshots[path.resolve(p)] = targetSnapshot(p); }
    catch (e) { warnings.push({ path: p, message: `cannot snapshot cleanup target: ${e.code ?? e.message}` }); }
  }
  return snapshots;
}
