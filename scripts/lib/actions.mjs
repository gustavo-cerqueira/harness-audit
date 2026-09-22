import fs from 'node:fs';
import path from 'node:path';
import { assertSupportedToml, removeTable, listTables } from './toml.mjs';

export const MANUAL_ACTIONS = ['edit-instructions'];
const INSTRUCTIONS = new Set(['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', 'CLAUDE.local.md', 'CLAUDE.override.md']);

const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { throw new Error(`invalid JSON in ${p}: ${e.message}`); } };
const writeJson = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
const need = (v, what) => { if (!v) throw new Error(`plan item missing ${what}`); return v; };
const requireSource = (item, ...sources) => {
  if (!sources.includes(item.source)) throw new Error(`unsupported source for ${item.action}: ${item.source ?? 'missing'}`);
};

function resolved(p) {
  let current = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return path.join(current, ...tail);
    tail.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...tail);
}

function under(p, root) {
  const candidate = resolved(p);
  const boundary = resolved(root);
  return candidate.startsWith(boundary + path.sep);
}

function assertContained(p, roots) {
  const inRoots = [roots.claudeRoot, roots.codexRoot].some(root => under(p, root));
  if (!inRoots || under(p, roots.out)) throw new Error(`refusing path outside harness roots: ${p}`);
}

function assertProtected(p, roots) {
  if (INSTRUCTIONS.has(path.basename(p))) throw new Error(`refusing instruction file: ${p}`);
  const self = [path.join(roots.claudeRoot, 'skills', 'harness-audit'), path.join(roots.codexRoot, 'skills', 'harness-audit')];
  if (self.some(root => resolved(p) === resolved(root) || resolved(p).startsWith(resolved(root) + path.sep))) throw new Error(`refusing harness-audit path: ${p}`);
}

function assertDirectChild(p, parent, label) {
  if (path.dirname(resolved(p)) !== resolved(parent)) throw new Error(`refusing ${label} outside its user scope: ${p}`);
}

function assertConfig(file) {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error(`refusing symlinked config: ${file}`);
}

function editJson(file, backup, fn) {
  assertConfig(file);
  if (!fs.existsSync(file)) return false;
  const obj = readJson(file);
  if (!fn(obj)) return false;
  backup.add(file);
  writeJson(file, obj);
  backup.markApplied(file);
  return true;
}

function editText(file, backup, fn) {
  assertConfig(file);
  if (!fs.existsSync(file)) return false;
  const before = fs.readFileSync(file, 'utf8');
  const after = fn(before);
  if (after === before) return false;
  backup.add(file);
  fs.writeFileSync(file, after);
  backup.markApplied(file);
  return true;
}

const ACTIONS = {
  'disable-plugin'(item, roots, backup) {
    const name = need(item.target, 'target');
    requireSource(item, `plugin:${name}`);
    if (item.enabledSource !== 'settings.json') throw new Error(`unsupported enabled source for ${name}: ${item.enabledSource ?? 'missing'}`);
    const file = path.join(roots.claudeRoot, 'settings.json');
    if (resolved(item.enabledPath ?? '') !== resolved(file)) throw new Error(`enabled path does not match source: ${item.enabledPath ?? 'missing'}`);
    let found = false;
    const ok = editJson(file, backup, s => {
      const keys = Object.keys(s.enabledPlugins ?? {}).filter(k => k.split('@')[0] === name);
      if (keys.length > 1) throw new Error(`plugin ${name} matches multiple marketplaces; disable the exact entry manually`);
      if (!keys.length) return false;
      const key = keys[0];
      for (const override of [path.join(roots.claudeRoot, 'settings.local.json'), path.join(roots.cwd, '.claude', 'settings.json'), path.join(roots.cwd, '.claude', 'settings.local.json')]) {
        if (fs.existsSync(override) && Object.hasOwn(readJson(override).enabledPlugins ?? {}, key))
          throw new Error(`plugin ${name} has a current override in ${override}; rerun the audit`);
      }
      found = true;
      if (s.enabledPlugins[key] === false) return false;
      s.enabledPlugins[key] = false;
      return true;
    });
    if (!ok) {
      if (found) return { changed: [], note: 'already disabled' };
      throw new Error(`plugin ${name} not found in settings.json — if it is synced from claude.ai, disable it there`);
    }
    return { changed: [file] };
  },
  'remove-skill'(item, roots, backup) {
    requireSource(item, 'user');
    let p = need(item.path, 'path');
    if (path.basename(p) === 'SKILL.md') p = path.dirname(p);
    const root = item.harness === 'claude' ? roots.claudeRoot : roots.codexRoot;
    assertDirectChild(p, path.join(root, 'skills'), 'skill');
    assertProtected(p, roots);
    if (!fs.existsSync(p)) throw new Error(`missing ${p}`);
    backup.move(p);
    return { changed: [p] };
  },
  'remove-agent'(item, roots, backup) {
    requireSource(item, 'user');
    const p = need(item.path, 'path');
    const root = item.harness === 'claude' ? roots.claudeRoot : roots.codexRoot;
    assertDirectChild(p, path.join(root, 'agents'), 'agent');
    assertProtected(p, roots);
    if (!fs.existsSync(p)) throw new Error(`missing ${p}`);
    backup.move(p);
    return { changed: [p] };
  },
  'delete-clutter'(item, roots, backup) {
    requireSource(item, `${need(item.harness, 'harness')}.clutter`);
    const p = need(item.path, 'path');
    assertProtected(p, roots);
    if (!fs.existsSync(p)) throw new Error(`missing ${p}`);
    backup.move(p);
    return { changed: [p] };
  },
  'remove-mcp'(item, roots, backup) {
    const name = need(item.target, 'target');
    if (item.harness === 'codex') {
      requireSource(item, 'config.toml');
      const file = path.join(roots.codexRoot, 'config.toml');
      if (resolved(item.path ?? '') !== resolved(file)) throw new Error(`mcp path does not match source: ${item.path ?? 'missing'}`);
      const ok = editText(file, backup, t => {
        assertSupportedToml(t);
        return removeTable(t, ['mcp_servers', name]);
      });
      if (!ok) throw new Error(`mcp server ${name} not found in ${file}`);
      return { changed: [file] };
    }
    const files = {
      '~/.claude.json': roots.claudeJson,
      'settings.json': path.join(roots.claudeRoot, 'settings.json'),
      'settings.local.json': path.join(roots.claudeRoot, 'settings.local.json'),
    };
    requireSource(item, ...Object.keys(files));
    const file = files[item.source];
    if (resolved(item.path ?? '') !== resolved(file)) throw new Error(`mcp path does not match source: ${item.path ?? 'missing'}`);
    const ok = editJson(file, backup, o => {
      if (!o.mcpServers || !(name in o.mcpServers)) return false;
      delete o.mcpServers[name];
      return true;
    });
    if (!ok) throw new Error(`mcp server ${name} not found in ${file}`);
    return { changed: [file] };
  },
  'remove-hook'(item, roots, backup) {
    const cmd = need(item.target, 'target');
    const event = need(item.event, 'event');
    if (typeof item.matcher !== 'string') throw new Error('plan item missing matcher');
    const matcher = item.matcher;
    const paths = item.harness === 'codex'
      ? { 'hooks.json': path.join(roots.codexRoot, 'hooks.json') }
      : { 'settings.json': path.join(roots.claudeRoot, 'settings.json'), 'settings.local.json': path.join(roots.claudeRoot, 'settings.local.json') };
    requireSource(item, ...Object.keys(paths));
    const file = paths[item.source];
    if (item.path && resolved(item.path) !== resolved(file)) throw new Error(`hook path does not match source: ${item.path}`);
    const ok = editJson(file, backup, o => {
      const hooks = o.hooks ?? {};
      let hit = false;
      hooks[event] = (hooks[event] ?? []).map(g => {
        if ((g.matcher ?? '') !== matcher) return g;
        return { ...g, hooks: (g.hooks ?? []).filter(h => { const drop = h.command === cmd; hit ||= drop; return !drop; }) };
      }).filter(g => g.hooks.length);
      if (!hooks[event].length) delete hooks[event];
      return hit;
    });
    if (!ok) throw new Error(`hook "${cmd}" not found in ${file}`);
    return { changed: [file] };
  },
  'prune-codex-projects'(item, roots, backup) {
    requireSource(item, 'codex.clutter');
    if (!Array.isArray(item.paths) || !item.paths.length || !item.paths.every(p => typeof p === 'string' && path.isAbsolute(p)))
      throw new Error('plan item missing dead project paths');
    const file = path.join(roots.codexRoot, 'config.toml');
    const approved = new Set(item.paths);
    const removed = [];
    const ok = editText(file, backup, t => {
      assertSupportedToml(t);
      let out = t;
      for (const tb of listTables(t)) if (tb.path[0] === 'projects' && tb.path.length === 2 && approved.has(tb.path[1]) && !fs.existsSync(tb.path[1])) { out = removeTable(out, tb.path); removed.push(tb.path[1]); }
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
  if (!['claude', 'codex'].includes(item.harness)) throw new Error(`invalid harness: ${item.harness}`);
  if (item.path && item.action !== 'remove-mcp') assertContained(item.path, roots);
  return fn(item, roots, backup);
}
