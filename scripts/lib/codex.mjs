// scripts/lib/codex.mjs
import fs from 'node:fs';
import path from 'node:path';
import { parseToml } from './toml.mjs';
import { readFrontmatter } from './frontmatter.mjs';
import { dirBytes, SELF } from './claude.mjs';

const tokens = s => Math.ceil(s.length / 4);

function skillsIn(dir, source, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(dirName => dirName !== SELF && fs.existsSync(path.join(dir, dirName, 'SKILL.md')))
    .map(dirName => {
      const p = path.join(dir, dirName, 'SKILL.md');
      const fm = readFrontmatter(fs.readFileSync(p, 'utf8'));
      const name = fm.name ?? dirName;
      return { id: prefix ? `${prefix}:${name}` : name, name, description: fm.description, source, path: p, descriptionChars: fm.description.length, loaded: true };
    })
    .filter(s => s.name !== SELF);
}

function tomlAgentMetadata(text) {
  const value = key => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*(?:#.*)?$`, 'm').exec(text);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
  };
  return { name: value('name'), description: value('description') ?? '' };
}

function configAgents(toml, root, configPath, warnings) {
  const out = [];
  for (const [name, cfg] of Object.entries(toml.agents ?? {})) {
    if (!cfg || typeof cfg !== 'object') continue;
    const description = typeof cfg.description === 'string' ? cfg.description : '';
    const file = typeof cfg.config_file === 'string' ? path.resolve(root, cfg.config_file) : null;
    if (!file && !description) continue;
    if (file && !fs.existsSync(file)) { warnings.push({ path: configPath, message: `agent ${name} config_file is missing` }); continue; }
    const metadata = file && file.endsWith('.toml') ? tomlAgentMetadata(fs.readFileSync(file, 'utf8')) : {};
    out.push({ id: metadata.name ?? name, name: metadata.name ?? name, description: description || metadata.description || '', source: 'config.toml', path: file ?? configPath, loaded: file ? true : null });
  }
  return out;
}

function agentsIn(dir, source, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir);
  const record = (f, loaded) => {
    const p = path.join(dir, f);
    const text = fs.readFileSync(p, 'utf8');
    const fm = f.endsWith('.md') ? readFrontmatter(text) : tomlAgentMetadata(text);
    const name = fm.name ?? f.replace(/\.(md|toml)$/, '');
    return { id: prefix ? `${prefix}:${name}` : name, name, description: fm.description, source, path: p, loaded };
  };
  const toml = files.filter(f => f.endsWith('.toml')).map(f => record(f, true));
  const configured = new Set(toml.map(a => a.id));
  // Codex exposes TOML profiles in its active agent catalog. Markdown-only files may be
  // legacy mirrors or another harness's profiles, so retain them as unknown rather than loaded.
  const markdown = files.filter(f => f.endsWith('.md')).map(f => record(f, null)).filter(a => !configured.has(a.id));
  return [...toml, ...markdown];
}

function flattenHooks(hooksObj, source, hookPath, into) {
  for (const [event, entries] of Object.entries(hooksObj ?? {})) for (const entry of entries ?? []) for (const x of entry.hooks ?? [])
    (into[event] ??= []).push({ command: x.command ?? x.type ?? '', matcher: entry.matcher ?? '', source, path: hookPath });
}

function ancestors(cwd) {
  const out = [];
  for (let p = path.resolve(cwd); ; p = path.dirname(p)) {
    out.unshift(p);
    if (path.dirname(p) === p) return out;
  }
}

function pluginParts(key) {
  const at = key.lastIndexOf('@');
  return at > 0 && at < key.length - 1 ? { name: key.slice(0, at), marketplace: key.slice(at + 1) } : null;
}

function codexPlugins(root, toml, warnings) {
  const out = [];
  for (const [key, cfg] of Object.entries(toml.plugins ?? {})) {
    if (!cfg || typeof cfg !== 'object') { warnings.push({ path: path.join(root, 'config.toml'), message: `plugin ${key} has unsupported configuration` }); continue; }
    const parts = pluginParts(key);
    const base = parts && path.join(root, 'plugins', 'cache', parts.marketplace, parts.name);
    const common = { name: parts?.name ?? key, marketplace: parts?.marketplace ?? null, enabled: cfg.enabled === true ? true : cfg.enabled === false ? false : null, enabledSource: 'config.toml', enabledPath: path.join(root, 'config.toml'), path: base ?? null, version: null, skills: null, agents: null, hooks: null, mcpServers: null, origin: 'config' };
    if (cfg.enabled !== true) { out.push({ ...common, loaded: cfg.enabled === false ? false : null, coverage: cfg.enabled === false ? 'disabled plugin cache not scanned' : 'plugin enabled state is unknown' }); continue; }
    if (!parts) { warnings.push({ path: path.join(root, 'config.toml'), message: `plugin ${key} has no marketplace; cache discovery skipped` }); out.push({ ...common, loaded: null, coverage: 'enabled plugin cache location is unsupported' }); continue; }
    let versions;
    try { versions = fs.readdirSync(base, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); }
    catch { warnings.push({ path: base, message: 'enabled plugin cache missing; discovery skipped' }); out.push({ ...common, loaded: null, coverage: 'enabled plugin cache is missing' }); continue; }
    if (versions.length !== 1) { warnings.push({ path: base, message: 'multiple cached plugin versions; active version is unknown' }); out.push({ ...common, loaded: null, coverage: 'active plugin version is unknown' }); continue; }
    const pluginPath = path.join(base, versions[0]);
    out.push({ ...common, path: pluginPath, version: versions[0], loaded: true, coverage: 'skills and agents only; plugin hooks and MCP are not discovered' });
  }
  return out;
}

function instructionFile(p) {
  if (!fs.existsSync(p)) return null;
  const text = fs.readFileSync(p, 'utf8');
  return { path: p, words: text.split(/\s+/).filter(Boolean).length, tokensEst: tokens(text) };
}

export function collectCodex(roots) {
  const root = roots.codexRoot;
  if (!fs.existsSync(root)) return null;
  const warnings = [];
  const configPath = path.join(root, 'config.toml');
  let toml = {};
  if (fs.existsSync(configPath)) {
    const tomlWarnings = [];
    try { toml = parseToml(fs.readFileSync(configPath, 'utf8'), tomlWarnings); }
    catch (e) { warnings.push({ path: configPath, message: e.message }); }
    for (const w of tomlWarnings) warnings.push({ path: configPath, message: `toml line ${w.line} unsupported: ${w.text.trim()}` });
  }
  const projects = Object.keys(toml.projects ?? {}).map(p => ({ path: p, exists: fs.existsSync(p) }));
  const mcpServers = Object.entries(toml.mcp_servers ?? {}).filter(([, cfg]) => cfg && typeof cfg === 'object').map(([name, cfg]) => ({
    name, source: 'config.toml', transport: cfg.url ? 'http' : 'stdio',
    path: configPath, command: cfg.url ?? [cfg.command, ...(cfg.args ?? [])].filter(Boolean).join(' '), enabled: cfg.enabled !== false,
  }));
  const hooks = {};
  const hooksPath = path.join(root, 'hooks.json');
  if (fs.existsSync(hooksPath)) {
    try {
      flattenHooks(JSON.parse(fs.readFileSync(hooksPath, 'utf8')).hooks, 'hooks.json', hooksPath, hooks);
    } catch (e) { warnings.push({ path: hooksPath, message: `json: ${e.message}` }); }
  }
  const clutter = [];
  for (const f of fs.readdirSync(root)) if (/\.(bak|backup)[^/]*$|\.orig$|~$/.test(f)) clutter.push({ path: path.join(root, f), kind: 'backup', bytes: dirBytes(path.join(root, f)) });
  for (const p of projects) if (!p.exists) clutter.push({ path: `${configPath}#projects.${p.path}`, kind: 'dead-project-entry', bytes: 0 });

  const plugins = codexPlugins(root, toml, warnings);
  const sharedRoot = roots.agentsRoot ?? (roots.home ? path.join(roots.home, '.agents') : null);
  const skills = [
    ...skillsIn(path.join(root, 'skills'), 'user'),
    ...skillsIn(path.join(root, 'skills', '.system'), 'system'),
    ...(sharedRoot ? skillsIn(path.join(sharedRoot, 'skills'), 'shared') : []),
    ...skillsIn(path.join(roots.cwd, '.codex', 'skills'), 'project'),
  ];
  const agents = [
    ...agentsIn(path.join(root, 'agents'), 'user'),
    ...agentsIn(path.join(roots.cwd, '.codex', 'agents'), 'project'),
  ];
  const sharedRoots = new Set(sharedRoot ? [path.resolve(sharedRoot)] : []);
  for (const dir of ancestors(roots.cwd)) {
    const candidate = path.join(dir, '.agents');
    if (sharedRoots.has(path.resolve(candidate))) continue;
    skills.push(...skillsIn(path.join(candidate, 'skills'), 'shared-project'));
    agents.push(...agentsIn(path.join(candidate, 'agents'), 'shared-project'));
  }
  for (const plugin of plugins.filter(p => p.loaded === true)) {
    const source = `plugin:${plugin.name}`;
    const pSkills = skillsIn(path.join(plugin.path, 'skills'), source, plugin.name);
    const pAgents = agentsIn(path.join(plugin.path, 'agents'), source, plugin.name);
    plugin.skills = pSkills.length; plugin.agents = pAgents.some(a => a.loaded == null) ? null : pAgents.length;
    skills.push(...pSkills); agents.push(...pAgents);
  }
  const projectHooksPath = path.join(roots.cwd, '.codex', 'hooks.json');
  if (fs.existsSync(projectHooksPath)) {
    try { flattenHooks(JSON.parse(fs.readFileSync(projectHooksPath, 'utf8')).hooks, 'project:.codex/hooks.json', projectHooksPath, hooks); }
    catch (e) { warnings.push({ path: projectHooksPath, message: `json: ${e.message}` }); }
  }
  const rootOverride = path.join(root, 'AGENTS.override.md');
  const instructionPaths = [fs.existsSync(rootOverride) ? rootOverride : path.join(root, 'AGENTS.md')];
  for (const dir of ancestors(roots.cwd)) {
    const override = path.join(dir, 'AGENTS.override.md');
    instructionPaths.push(fs.existsSync(override) ? override : path.join(dir, 'AGENTS.md'));
  }
  const configuredAgents = configAgents(toml, root, configPath, warnings);
  for (const profile of configuredAgents) {
    const existing = agents.find(a => path.resolve(a.path) === path.resolve(profile.path));
    if (existing) {
      if (!existing.description) existing.description = profile.description;
      continue;
    }
    agents.push(profile);
  }
  return {
    root,
    config: { model: toml.model ?? null, effort: toml.model_reasoning_effort ?? null, projects },
    plugins, skills, agents,
    hooks, mcpServers,
    instructionFiles: [...new Set(instructionPaths)].map(instructionFile).filter(Boolean),
    clutter, warnings,
  };
}
