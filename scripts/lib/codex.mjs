// scripts/lib/codex.mjs
import fs from 'node:fs';
import path from 'node:path';
import { parseToml } from './toml.mjs';
import { readFrontmatter } from './frontmatter.mjs';
import { dirBytes, SELF } from './claude.mjs';

const tokens = s => Math.ceil(s.length / 4);

function skillsIn(dir, source) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(dirName => dirName !== SELF && fs.existsSync(path.join(dir, dirName, 'SKILL.md')))
    .map(dirName => {
      const p = path.join(dir, dirName, 'SKILL.md');
      const fm = readFrontmatter(fs.readFileSync(p, 'utf8'));
      const name = fm.name ?? dirName;
      return { id: name, name, description: fm.description, source, path: p, descriptionChars: fm.description.length, loaded: true };
    })
    .filter(s => s.name !== SELF);
}

function agentsIn(dir, source) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /\.(md|toml)$/.test(f)).map(f => {
    const p = path.join(dir, f);
    const fm = f.endsWith('.md') ? readFrontmatter(fs.readFileSync(p, 'utf8')) : { name: null, description: '' };
    return { id: fm.name ?? f.replace(/\.(md|toml)$/, ''), description: fm.description, source, path: p, loaded: true };
  });
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
  const mcpServers = Object.entries(toml.mcp_servers ?? {}).map(([name, cfg]) => ({
    name, source: 'config.toml', transport: cfg.url ? 'http' : 'stdio',
    command: cfg.url ?? [cfg.command, ...(cfg.args ?? [])].filter(Boolean).join(' '), enabled: cfg.enabled !== false,
  }));
  const hooks = {};
  const hooksPath = path.join(root, 'hooks.json');
  if (fs.existsSync(hooksPath)) {
    try {
      const h = JSON.parse(fs.readFileSync(hooksPath, 'utf8')).hooks ?? {};
      for (const [event, entries] of Object.entries(h)) for (const entry of entries ?? []) for (const x of entry.hooks ?? [])
        (hooks[event] ??= []).push({ command: x.command ?? x.type ?? '', matcher: entry.matcher ?? '', source: 'hooks.json' });
    } catch (e) { warnings.push({ path: hooksPath, message: `json: ${e.message}` }); }
  }
  const clutter = [];
  for (const f of fs.readdirSync(root)) if (/\.(bak|backup)[^/]*$|\.orig$|~$/.test(f)) clutter.push({ path: path.join(root, f), kind: 'backup', bytes: dirBytes(path.join(root, f)) });
  for (const p of projects) if (!p.exists) clutter.push({ path: `${configPath}#projects.${p.path}`, kind: 'dead-project-entry', bytes: 0 });

  return {
    root,
    config: { model: toml.model ?? null, effort: toml.model_reasoning_effort ?? null, projects },
    skills: [...skillsIn(path.join(root, 'skills'), 'user'), ...skillsIn(path.join(roots.cwd, '.codex', 'skills'), 'project')],
    agents: agentsIn(path.join(root, 'agents'), 'user'),
    hooks, mcpServers,
    instructionFiles: [path.join(root, 'AGENTS.md'), path.join(roots.cwd, 'AGENTS.md')].map(instructionFile).filter(Boolean),
    clutter, warnings,
  };
}
