// scripts/lib/actions.mjs
import fs from 'node:fs';
import path from 'node:path';
import { removeTable, listTables } from './toml.mjs';

export const MANUAL_ACTIONS = ['edit-instructions'];

const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { throw new Error(`invalid JSON in ${p}: ${e.message}`); } };
const writeJson = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
const need = (v, what) => { if (!v) throw new Error(`plan item missing ${what}`); return v; };

function assertContained(p, roots) {
  const real = x => { try { return fs.realpathSync(x); } catch { return path.resolve(x); } };
  const resolved = path.join(real(path.dirname(p)), path.basename(p));
  const outReal = real(roots.out);
  const inOut = resolved === outReal || resolved.startsWith(outReal + path.sep);
  const inRoots = [roots.claudeRoot, roots.codexRoot].some(r => resolved.startsWith(real(r) + path.sep));
  if (inOut || !inRoots) throw new Error(`refusing path outside harness roots: ${p}`);
}

function editJson(file, backup, fn) {
  if (!fs.existsSync(file)) return false;
  const obj = readJson(file);
  if (!fn(obj)) return false;
  backup.add(file);
  writeJson(file, obj);
  return true;
}

function editText(file, backup, fn) {
  if (!fs.existsSync(file)) return false;
  const before = fs.readFileSync(file, 'utf8');
  const after = fn(before);
  if (after === before) return false;
  backup.add(file);
  fs.writeFileSync(file, after);
  return true;
}

const ACTIONS = {
  'disable-plugin'(item, roots, backup) {
    const file = path.join(roots.claudeRoot, 'settings.json');
    const name = need(item.target, 'target');
    let found = false;
    const ok = editJson(file, backup, s => {
      let hit = false;
      for (const k of Object.keys(s.enabledPlugins ?? {})) {
        if (k.split('@')[0] !== name) continue;
        found = true;
        if (s.enabledPlugins[k] !== false) { s.enabledPlugins[k] = false; hit = true; }
      }
      return hit;
    });
    if (!ok) {
      if (found) return { changed: [], note: 'already disabled' };
      throw new Error(`plugin ${name} not found in settings.json — if it is synced from claude.ai, disable it there`);
    }
    return { changed: [file] };
  },
  'remove-skill'(item, roots, backup) {
    let p = need(item.path, 'path');
    if (path.basename(p) === 'SKILL.md') p = path.dirname(p);
    if (!fs.existsSync(p)) throw new Error(`missing ${p}`);
    backup.move(p);
    return { changed: [p] };
  },
  'remove-agent'(item, roots, backup) { const p = need(item.path, 'path'); if (!fs.existsSync(p)) throw new Error(`missing ${p}`); backup.move(p); return { changed: [p] }; },
  'delete-clutter'(item, roots, backup) { const p = need(item.path, 'path'); if (!fs.existsSync(p)) throw new Error(`missing ${p}`); backup.move(p); return { changed: [p] }; },
  'remove-mcp'(item, roots, backup) {
    const name = need(item.target, 'target');
    if (item.harness === 'codex') {
      const file = path.join(roots.codexRoot, 'config.toml');
      const ok = editText(file, backup, t => removeTable(t, ['mcp_servers', name]));
      if (!ok) throw new Error(`mcp server ${name} not found in ${file}`);
      return { changed: [file] };
    }
    const changed = [];
    for (const file of [roots.claudeJson, path.join(roots.claudeRoot, 'settings.json'), path.join(roots.claudeRoot, 'settings.local.json')]) {
      if (editJson(file, backup, o => { if (o.mcpServers && name in o.mcpServers) { delete o.mcpServers[name]; return true; } return false; })) changed.push(file);
    }
    if (!changed.length) throw new Error(`mcp server ${name} not found in claude config files`);
    return { changed };
  },
  'remove-hook'(item, roots, backup) {
    const file = need(item.path, 'path'), cmd = need(item.target, 'target');
    const ok = editJson(file, backup, o => {
      const hooks = o.hooks ?? {};
      let hit = false;
      for (const ev of Object.keys(hooks)) {
        hooks[ev] = (hooks[ev] ?? []).map(g => ({ ...g, hooks: (g.hooks ?? []).filter(h => { const drop = h.command === cmd; hit ||= drop; return !drop; }) })).filter(g => g.hooks.length);
        if (!hooks[ev].length) delete hooks[ev];
      }
      return hit;
    });
    if (!ok) throw new Error(`hook "${cmd}" not found in ${file}`);
    return { changed: [file] };
  },
  'prune-codex-projects'(item, roots, backup) {
    const file = path.join(roots.codexRoot, 'config.toml');
    const removed = [];
    const ok = editText(file, backup, t => {
      let out = t;
      for (const tb of listTables(t)) if (tb.path[0] === 'projects' && tb.path.length === 2 && !fs.existsSync(tb.path[1])) { out = removeTable(out, tb.path); removed.push(tb.path[1]); }
      return out;
    });
    if (!ok) return { changed: [], note: 'no dead project entries' };
    return { changed: [file], note: `removed ${removed.length} entries` };
  },
  'edit-instructions'(item) { throw new Error(`${item.id}: manual action, edit ${item.path} by hand: ${item.reason}`); },
};

export function applyItem(item, roots, backup) {
  const fn = ACTIONS[item.action];
  if (!fn) throw new Error(`unknown action ${item.action}`);
  if (item.path) assertContained(item.path, roots);
  return fn(item, roots, backup);
}
