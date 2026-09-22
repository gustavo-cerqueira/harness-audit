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

// Claude Code rewrites ~/.claude.json every few seconds, so a server in a JSON config is
// fingerprinted by its own entry; whole-file metadata would never match at apply time.
export const jsonServerEntry = (source, file) => file.endsWith('.json') && !source.includes('#');
export const serverKey = (file, name) => `${path.resolve(file)}#mcpServers.${name}`;
export function serverSnapshot(file, name) {
  const entry = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers?.[name];
  return crypto.createHash('sha256').update(JSON.stringify(entry ?? null)).digest('hex');
}

export function snapshotTargets(claude, codex, warnings) {
  const paths = new Set();
  const servers = [];
  for (const section of [claude, codex].filter(Boolean)) {
    for (const s of section.skills) paths.add(path.dirname(s.path));
    for (const a of section.agents) paths.add(a.path);
    for (const p of section.plugins ?? []) if (p.enabledPath) paths.add(p.enabledPath);
    for (const s of section.mcpServers) if (s.path) jsonServerEntry(s.source, s.path) ? servers.push(s) : paths.add(s.path);
    for (const hooks of Object.values(section.hooks)) for (const h of hooks) if (h.path) paths.add(h.path);
    for (const c of section.clutter) if (c.kind !== 'dead-project-entry') paths.add(c.path);
  }
  if (codex?.clutter.some(c => c.kind === 'dead-project-entry')) paths.add(path.join(codex.root, 'config.toml'));
  const snapshots = {};
  for (const p of paths) {
    try { snapshots[path.resolve(p)] = targetSnapshot(p); }
    catch (e) { warnings.push({ path: p, message: `cannot snapshot cleanup target: ${e.code ?? e.message}` }); }
  }
  for (const s of servers) {
    try { snapshots[serverKey(s.path, s.name)] = serverSnapshot(s.path, s.name); }
    catch (e) { warnings.push({ path: s.path, message: `cannot snapshot MCP server ${s.name}: ${e.code ?? e.message}` }); }
  }
  return snapshots;
}
