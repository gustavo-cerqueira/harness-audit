// scripts/lib/claude.mjs
import fs from 'node:fs';
import path from 'node:path';
import { readFrontmatter } from './frontmatter.mjs';

export const SELF = 'harness-audit';
const tokens = s => Math.ceil(s.length / 4);
const readJson = (p, warnings) => {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { warnings.push({ path: p, message: `json: ${e.message}` }); return null; }
};

export function dirBytes(p) {
  if (!fs.existsSync(p)) return 0;
  const st = fs.statSync(p);
  if (st.isFile()) return st.size;
  return fs.readdirSync(p).reduce((n, e) => n + dirBytes(path.join(p, e)), 0);
}

function skillsIn(dir, source, prefix, loaded) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => name !== SELF && fs.existsSync(path.join(dir, name, 'SKILL.md')))
    .map(dirName => {
      const p = path.join(dir, dirName, 'SKILL.md');
      const fm = readFrontmatter(fs.readFileSync(p, 'utf8'));
      const name = fm.name ?? dirName;
      return { id: prefix ? `${prefix}:${name}` : name, name, description: fm.description, source, path: p, descriptionChars: fm.description.length, loaded };
    })
    .filter(s => s.name !== SELF);
}

function agentsIn(dir, source, prefix, loaded) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.md')).map(f => {
    const p = path.join(dir, f);
    const fm = readFrontmatter(fs.readFileSync(p, 'utf8'));
    const name = fm.name ?? f.replace(/\.md$/, '');
    return { id: prefix ? `${prefix}:${name}` : name, description: fm.description, source, path: p, loaded };
  });
}

function flattenHooks(hooksObj, source, into) {
  for (const [event, entries] of Object.entries(hooksObj ?? {})) {
    for (const entry of entries ?? []) {
      for (const h of entry.hooks ?? []) {
        (into[event] ??= []).push({ command: h.command ?? h.type ?? '', matcher: entry.matcher ?? '', source });
      }
    }
  }
}

function mcpFrom(obj, source, into) {
  for (const [name, cfg] of Object.entries(obj ?? {})) {
    const transport = cfg.url || cfg.type === 'http' || cfg.type === 'sse' ? 'http' : 'stdio';
    into.push({ name, source, transport, command: cfg.url ?? [cfg.command, ...(cfg.args ?? [])].filter(Boolean).join(' '), enabled: cfg.disabled !== true });
  }
}

function instructionFile(p) {
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, 'utf8');
  return { path: p, words: text.split(/\s+/).filter(Boolean).length, tokensEst: tokens(text) };
}

function clutterIn(root, warnings) {
  const out = [];
  const push = (p, kind) => out.push({ path: p, kind, bytes: dirBytes(p) });
  if (fs.existsSync(root)) for (const f of fs.readdirSync(root)) if (/\.(bak|backup)[^/]*$|\.orig$|~$/.test(f)) push(path.join(root, f), 'backup');
  const cache = path.join(root, 'plugins', 'cache');
  if (fs.existsSync(cache)) {
    for (const mk of fs.readdirSync(cache)) {
      const mkDir = path.join(cache, mk);
      if (/^temp_/.test(mk)) { push(mkDir, 'temp-clone'); continue; }
      if (!fs.statSync(mkDir).isDirectory()) continue;
      for (const plugin of fs.readdirSync(mkDir)) {
        const pDir = path.join(mkDir, plugin);
        if (!fs.statSync(pDir).isDirectory()) continue;
        for (const ver of fs.readdirSync(pDir)) {
          const vDir = path.join(pDir, ver);
          if (fs.existsSync(path.join(vDir, '.orphaned_at'))) push(vDir, 'orphaned-plugin-version');
        }
      }
    }
  }
  const projects = path.join(root, 'projects');
  if (fs.existsSync(projects)) {
    for (const slug of fs.readdirSync(projects)) {
      const d = path.join(projects, slug);
      if (!fs.statSync(d).isDirectory()) continue;
      let jsonl;
      try {
        jsonl = fs.readdirSync(d).filter(f => f.endsWith('.jsonl')).map(f => path.join(d, f))
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
      } catch { continue; }
      if (!jsonl) continue;
      // ponytail: only the first 64 KiB is read looking for a "cwd" line (transcripts can run hundreds of MB);
      // upgrade path is a line-by-line streaming reader (like scanJsonl) if 64 KiB ever proves too small.
      const buf = Buffer.alloc(65536);
      let n;
      try {
        const fd = fs.openSync(jsonl, 'r');
        try { n = fs.readSync(fd, buf, 0, buf.length, 0); }
        finally { fs.closeSync(fd); }
      } catch (e) { warnings.push({ path: jsonl, message: `read: ${e.message}` }); continue; }
      const first = buf.toString('utf8', 0, n).split('\n').find(l => l.includes('"cwd"'));
      if (!first) continue;
      let cwd;
      try { cwd = JSON.parse(first).cwd; } catch { continue; }
      if (cwd && !fs.existsSync(cwd)) push(d, 'stale-project-dir');
    }
  }
  return out;
}

export function collectClaude(roots) {
  const root = roots.claudeRoot;
  if (!fs.existsSync(root)) return null;
  const warnings = [];
  const settings = readJson(path.join(root, 'settings.json'), warnings) ?? {};
  const settingsLocal = readJson(path.join(root, 'settings.local.json'), warnings) ?? {};
  const projSettings = readJson(path.join(roots.cwd, '.claude', 'settings.json'), warnings) ?? {};
  const claudeJson = readJson(roots.claudeJson, warnings) ?? {};
  const installed = readJson(path.join(root, 'plugins', 'installed_plugins.json'), warnings)?.plugins ?? {};
  const enabledPlugins = { ...settings.enabledPlugins, ...settingsLocal.enabledPlugins, ...projSettings.enabledPlugins };

  const plugins = [], skills = [], agents = [], hooks = {}, mcpServers = [];
  for (const [key, installs] of Object.entries(installed)) {
    const [name, marketplace] = key.split('@');
    const inst = installs?.[0];
    if (!inst?.installPath || !fs.existsSync(inst.installPath)) { warnings.push({ path: inst?.installPath ?? key, message: 'plugin install path missing' }); continue; }
    const enabled = enabledPlugins[key] === true;
    const src = `plugin:${name}`;
    const pSkills = skillsIn(path.join(inst.installPath, 'skills'), src, name, enabled);
    const pAgents = agentsIn(path.join(inst.installPath, 'agents'), src, name, enabled);
    const pHooks = readJson(path.join(inst.installPath, 'hooks', 'hooks.json'), warnings)?.hooks ?? {};
    const pMcp = readJson(path.join(inst.installPath, '.mcp.json'), warnings)?.mcpServers ?? {};
    const hookCount = Object.values(pHooks).flat().reduce((n, e) => n + (e.hooks?.length ?? 0), 0);
    plugins.push({ name, marketplace, enabled, path: inst.installPath, version: inst.version ?? null, installedAt: inst.installedAt ?? null, skills: pSkills.length, agents: pAgents.length, hooks: hookCount, mcpServers: Object.keys(pMcp).length, origin: 'installed' });
    skills.push(...pSkills); agents.push(...pAgents);
    if (enabled) { flattenHooks(pHooks, src, hooks); mcpFrom(pMcp, src, mcpServers); }
  }

  // plugins synced from claude.ai: plugins/synced/<sync-id>/manifest.json + plugins/synced/<sync-id>/<name>/
  const syncedRoot = path.join(root, 'plugins', 'synced');
  if (fs.existsSync(syncedRoot)) {
    for (const syncId of fs.readdirSync(syncedRoot)) {
      const syncDir = path.join(syncedRoot, syncId);
      if (!fs.statSync(syncDir).isDirectory()) continue;
      const manifestPath = path.join(syncDir, 'manifest.json');
      const manifest = readJson(manifestPath, warnings);
      const entries = Array.isArray(manifest?.plugins) ? manifest.plugins : [];
      if (manifest && !Array.isArray(manifest.plugins)) warnings.push({ path: manifestPath, message: 'synced manifest plugins is not an array' });
      for (const entry of entries) {
        if (typeof entry?.name !== 'string' || !entry.name) { warnings.push({ path: manifestPath, message: 'synced plugin entry without name' }); continue; }
        const name = entry.name;
        const pluginPath = path.join(syncDir, name);
        if (!fs.existsSync(pluginPath)) { warnings.push({ path: pluginPath, message: 'synced plugin directory missing' }); continue; }
        const enabled = entry.installationPreference === 'available';
        const src = `plugin:${name}`;
        const pSkills = skillsIn(path.join(pluginPath, 'skills'), src, name, enabled);
        const pAgents = agentsIn(path.join(pluginPath, 'agents'), src, name, enabled);
        const pHooks = readJson(path.join(pluginPath, 'hooks', 'hooks.json'), warnings)?.hooks ?? {};
        const pMcp = readJson(path.join(pluginPath, '.mcp.json'), warnings)?.mcpServers ?? {};
        const hookCount = Object.values(pHooks).flat().reduce((n, e) => n + (e.hooks?.length ?? 0), 0);
        plugins.push({ name, marketplace: entry.marketplaceName ?? 'synced', enabled, path: pluginPath, version: entry.version ?? null, installedAt: entry.updatedAt ?? null, skills: pSkills.length, agents: pAgents.length, hooks: hookCount, mcpServers: Object.keys(pMcp).length, origin: 'synced' });
        skills.push(...pSkills); agents.push(...pAgents);
        if (enabled) { flattenHooks(pHooks, src, hooks); mcpFrom(pMcp, src, mcpServers); }
      }
    }
  }

  skills.push(...skillsIn(path.join(root, 'skills'), 'user', '', true));
  skills.push(...skillsIn(path.join(roots.cwd, '.claude', 'skills'), 'project', '', true));
  agents.push(...agentsIn(path.join(root, 'agents'), 'user', '', true));
  agents.push(...agentsIn(path.join(roots.cwd, '.claude', 'agents'), 'project', '', true));
  flattenHooks(settings.hooks, 'settings.json', hooks);
  flattenHooks(settingsLocal.hooks, 'settings.local.json', hooks);
  flattenHooks(projSettings.hooks, 'project:.claude/settings.json', hooks);
  mcpFrom(claudeJson.mcpServers, '~/.claude.json', mcpServers);
  for (const [proj, cfg] of Object.entries(claudeJson.projects ?? {})) mcpFrom(cfg.mcpServers, `~/.claude.json#project:${proj}`, mcpServers);
  mcpFrom(settings.mcpServers, 'settings.json', mcpServers);
  mcpFrom(settingsLocal.mcpServers, 'settings.local.json', mcpServers);
  mcpFrom(readJson(path.join(roots.cwd, '.mcp.json'), warnings)?.mcpServers, 'project:.mcp.json', mcpServers);

  const instructionFiles = [
    path.join(root, 'CLAUDE.md'), path.join(roots.cwd, 'CLAUDE.md'), path.join(roots.cwd, 'CLAUDE.local.md'), path.join(roots.cwd, '.claude', 'CLAUDE.md'),
  ].map(instructionFile).filter(Boolean);

  return { root, plugins, skills, agents, hooks, mcpServers, instructionFiles, clutter: clutterIn(root, warnings), warnings };
}
