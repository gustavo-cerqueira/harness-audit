import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRoots } from '../scripts/lib/args.mjs';
import { collectClaude } from '../scripts/lib/claude.mjs';
import { collectCodex } from '../scripts/lib/codex.mjs';
import { buildFixture } from './helpers/fixture.mjs';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ha-discovery-'));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const skill = (dir, name) => write(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} description\n---\n`);
const agent = (file, name, description = `${name} description`) => write(file, `name = "${name}"\ndescription = "${description}"\n`);

test('resolveRoots honors harness environment roots', () => {
  const roots = resolveRoots({}, { HOME: '/home/a', CODEX_HOME: '/codex', CLAUDE_CONFIG_DIR: '/claude' });
  assert.equal(roots.codexRoot, '/codex');
  assert.equal(roots.claudeRoot, '/claude');
  assert.equal(roots.agentsRoot, '/home/a/.agents');
  const explicitHome = resolveRoots({ home: '/fixture' }, { HOME: '/home/a', CODEX_HOME: '/real/codex', CLAUDE_CONFIG_DIR: '/real/claude' });
  assert.equal(explicitHome.codexRoot, '/fixture/.codex');
  assert.equal(explicitHome.claudeRoot, '/fixture/.claude');
});

test('Claude collects current project local settings and only current project MCP configuration', () => {
  const r = buildFixture(temp());
  const local = path.join(r.cwd, '.claude', 'settings.local.json');
  write(local, JSON.stringify({
    enabledPlugins: { 'beta@mk': true },
    hooks: { Stop: [{ hooks: [{ command: 'project-local-hook' }] }] },
    mcpServers: { projectLocal: { command: 'local' } },
  }));
  const config = JSON.parse(fs.readFileSync(r.claudeJson, 'utf8'));
  config.projects['/other/project'] = { mcpServers: { otherProject: { command: 'other' } } };
  write(r.claudeJson, JSON.stringify(config));

  const c = collectClaude(r);
  assert.equal(c.plugins.find(p => p.name === 'beta').enabled, true);
  assert.ok(c.hooks.Stop.some(h => h.command === 'project-local-hook' && h.source === 'project:.claude/settings.local.json' && h.path === local));
  assert.equal(c.mcpServers.find(s => s.name === 'projectLocal').source, 'project:.claude/settings.local.json');
  assert.ok(c.mcpServers.some(s => s.name === 'projsrv'));
  assert.equal(c.mcpServers.some(s => s.name === 'otherProject'), false);
});

test('Claude refuses to guess among multiple applicable plugin installs', () => {
  const r = buildFixture(temp());
  const installedPath = path.join(r.claudeRoot, 'plugins', 'installed_plugins.json');
  const installed = JSON.parse(fs.readFileSync(installedPath, 'utf8'));
  const alpha = installed.plugins['alpha@mk'][0];
  const second = path.join(r.claudeRoot, 'plugins', 'cache', 'mk', 'alpha', 'v2');
  skill(path.join(second, 'skills'), 'other-alpha');
  installed.plugins['alpha@mk'] = [alpha, { ...alpha, installPath: second, version: 'v2' }];
  write(installedPath, JSON.stringify(installed));

  const c = collectClaude(r);
  assert.equal(c.plugins.find(p => p.name === 'alpha').loaded, null);
  assert.equal(c.plugins.find(p => p.name === 'alpha').skills, null);
  assert.ok(c.warnings.some(w => /multiple applicable plugin installs/.test(w.message)));
});

test('Claude selects only the current project-scoped install', () => {
  const r = buildFixture(temp());
  const installedPath = path.join(r.claudeRoot, 'plugins', 'installed_plugins.json');
  const installed = JSON.parse(fs.readFileSync(installedPath, 'utf8'));
  const alpha = installed.plugins['alpha@mk'][0];
  const current = path.join(r.claudeRoot, 'plugins', 'cache', 'mk', 'alpha', 'current');
  const other = path.join(r.claudeRoot, 'plugins', 'cache', 'mk', 'alpha', 'other');
  skill(path.join(current, 'skills'), 'current-alpha');
  skill(path.join(other, 'skills'), 'other-alpha');
  installed.plugins['alpha@mk'] = [alpha, { ...alpha, scope: 'project', projectPath: r.cwd, installPath: current }, { ...alpha, scope: 'local', projectPath: '/other', installPath: other }];
  write(installedPath, JSON.stringify(installed));
  write(path.join(r.cwd, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'alpha@mk': true } }));

  const c = collectClaude(r);
  assert.equal(c.plugins.find(p => p.name === 'alpha').path, current);
  assert.equal(c.plugins.find(p => p.name === 'alpha').enabledSource, 'project:.claude/settings.local.json');
});

test('Codex resolves supported shared, system, project, plugin and override scopes without scanning ambiguous caches', () => {
  const home = temp();
  const root = path.join(home, '.codex');
  const shared = path.join(home, '.agents');
  const cwd = path.join(home, 'workspace', 'app');
  const ancestor = path.join(home, 'workspace');
  write(path.join(root, 'config.toml'), '[plugins."plug@market"]\nenabled = true\n\n[plugins."ambiguous@market"]\nenabled = true\n\n[plugins."disabled@market"]\nenabled = false\n\n[plugins."unknown@market"]\nlabel = "unknown"\n\n[agents.config-profile]\ndescription = "configured profile"\nconfig_file = "config-profile.toml"\n');
  skill(path.join(root, 'skills'), 'user-skill');
  skill(path.join(root, 'skills', '.system'), 'system-skill');
  skill(path.join(shared, 'skills'), 'shared-skill');
  skill(path.join(cwd, '.codex', 'skills'), 'project-skill');
  skill(path.join(ancestor, '.agents', 'skills'), 'ancestor-skill');
  agent(path.join(root, 'agents', 'global.toml'), 'global-agent', 'global profile');
  write(path.join(root, 'agents', 'legacy.md'), '---\nname: legacy-agent\ndescription: legacy mirror\n---\n');
  agent(path.join(root, 'config-profile.toml'), 'config-agent', 'file profile');
  agent(path.join(cwd, '.codex', 'agents', 'project.toml'), 'project-agent', 'project profile');
  agent(path.join(ancestor, '.agents', 'agents', 'ancestor.toml'), 'ancestor-agent');
  const plugin = path.join(root, 'plugins', 'cache', 'market', 'plug', '1.0.0');
  skill(path.join(plugin, 'skills'), 'plugin-skill');
  agent(path.join(plugin, 'agents', 'plugin.toml'), 'plugin-agent', 'plugin profile');
  skill(path.join(root, 'plugins', 'cache', 'market', 'ambiguous', '1.0.0', 'skills'), 'old');
  skill(path.join(root, 'plugins', 'cache', 'market', 'ambiguous', '2.0.0', 'skills'), 'new');
  write(path.join(cwd, '.codex', 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'project-hook' }] }] } }));
  write(path.join(ancestor, 'AGENTS.md'), 'ordinary ancestor instructions');
  write(path.join(ancestor, 'AGENTS.override.md'), 'override ancestor instructions');
  write(path.join(cwd, 'AGENTS.md'), 'current instructions');
  write(path.join(root, 'AGENTS.md'), 'global instructions');
  write(path.join(root, 'AGENTS.override.md'), 'global override instructions');

  const c = collectCodex({ home, codexRoot: root, agentsRoot: shared, cwd });
  assert.deepEqual(c.skills.map(s => s.id).sort(), ['ancestor-skill', 'plug:plugin-skill', 'project-skill', 'shared-skill', 'system-skill', 'user-skill']);
  assert.deepEqual(c.agents.map(a => a.id).sort(), ['ancestor-agent', 'config-agent', 'global-agent', 'legacy-agent', 'plug:plugin-agent', 'project-agent']);
  assert.equal(c.agents.find(a => a.id === 'plug:plugin-agent').description, 'plugin profile');
  assert.equal(c.agents.find(a => a.id === 'config-agent').description, 'configured profile');
  assert.equal(c.agents.find(a => a.id === 'legacy-agent').loaded, null);
  assert.equal(c.plugins.length, 4);
  assert.equal(c.plugins.find(p => p.name === 'plug').path, plugin);
  assert.equal(c.plugins.find(p => p.name === 'ambiguous').loaded, null);
  assert.equal(c.plugins.find(p => p.name === 'disabled').hooks, null);
  assert.equal(c.plugins.find(p => p.name === 'unknown').loaded, null);
  assert.ok(c.hooks.Stop.some(h => h.command === 'project-hook' && h.source === 'project:.codex/hooks.json'));
  const instructions = c.instructionFiles.map(f => f.path);
  assert.ok(instructions.includes(path.join(ancestor, 'AGENTS.override.md')));
  assert.equal(instructions.includes(path.join(ancestor, 'AGENTS.md')), false);
  assert.ok(instructions.includes(path.join(root, 'AGENTS.override.md')));
  assert.equal(instructions.includes(path.join(root, 'AGENTS.md')), false);
  assert.ok(c.warnings.some(w => /multiple cached plugin versions/.test(w.message)));
});
