import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFixture } from './helpers/fixture.mjs';
import { collectClaude } from '../scripts/lib/claude.mjs';

const fx = () => buildFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'ha-')));
const ids = arr => arr.map(x => x.id).sort();

test('collectClaude: plugins with enabled flag and counts', () => {
  const c = collectClaude(fx());
  assert.equal(c.plugins.length, 3);
  const alpha = c.plugins.find(p => p.name === 'alpha');
  const beta = c.plugins.find(p => p.name === 'beta');
  const gamma = c.plugins.find(p => p.name === 'gamma');
  assert.equal(alpha.enabled, true);
  assert.equal(alpha.marketplace, 'mk');
  assert.equal(alpha.origin, 'installed');
  assert.deepEqual([alpha.skills, alpha.agents, alpha.hooks, alpha.mcpServers], [3, 1, 1, 1]);
  assert.equal(typeof alpha.installedAt, 'string');
  assert.equal(beta.enabled, false);
  assert.equal(gamma.origin, 'synced');
  assert.equal(gamma.enabled, true);
});

test('collectClaude: synced manifest entry without name warns and is skipped, other entries still collected', () => {
  const r = fx();
  fs.writeFileSync(path.join(r.claudeRoot, 'plugins', 'synced', 'sync-1', 'manifest.json'), JSON.stringify({
    plugins: [
      { version: '1' },
      { name: 'gamma', marketplaceName: 'knowledge-work-plugins', installationPreference: 'available', version: '0001' },
    ],
  }));
  const c = collectClaude(r);
  assert.ok(c.warnings.some(w => /without name/.test(w.message)));
  assert.ok(c.plugins.some(p => p.name === 'gamma'));
});

test('collectClaude: synced manifest plugins not an array warns and yields no synced plugins', () => {
  const r = fx();
  fs.writeFileSync(path.join(r.claudeRoot, 'plugins', 'synced', 'sync-1', 'manifest.json'), JSON.stringify({ plugins: 'nope' }));
  const c = collectClaude(r);
  assert.ok(c.warnings.some(w => /not an array/.test(w.message)));
  assert.equal(c.plugins.length, 2);
});

test('collectClaude: skills from user dir and plugins, audit skill excluded, disabled plugin skills not loaded', () => {
  const c = collectClaude(fx());
  assert.deepEqual(ids(c.skills), ['alpha:brainstorming', 'alpha:debugging', 'alpha:review', 'beta:one', 'gamma:invoice', 'gamma:sales', 'grill-me', 'grilling', 'linked-skill']);
  assert.equal(c.skills.find(s => s.id === 'grilling').source, 'user');
  assert.equal(c.skills.find(s => s.id === 'linked-skill').source, 'user');
  assert.equal(c.skills.find(s => s.id === 'alpha:review').source, 'plugin:alpha');
  assert.equal(c.skills.find(s => s.id === 'beta:one').loaded, false);
  assert.equal(c.skills.find(s => s.id === 'alpha:review').loaded, true);
  assert.equal(c.skills.find(s => s.id === 'grilling').descriptionChars, 'Grill the user about a plan.'.length);
});

test('collectClaude: agents', () => {
  const c = collectClaude(fx());
  assert.deepEqual(ids(c.agents), ['alpha:explorer', 'gsd-planner']);
});

test('collectClaude: hooks flattened per event with source, disabled plugin hooks excluded', () => {
  const c = collectClaude(fx());
  assert.equal(c.hooks.PreToolUse.length, 3);
  assert.deepEqual(c.hooks.PreToolUse.map(h => h.command), ['node guard1.js', 'node guard2.js', 'node guard3.js']);
  assert.equal(c.hooks.PreToolUse[0].matcher, 'Bash');
  assert.equal(c.hooks.PreToolUse[0].source, 'settings.json');
  assert.deepEqual(c.hooks.SessionStart.map(h => h.source), ['plugin:alpha']);
});

test('collectClaude: mcp servers from all sources', () => {
  const c = collectClaude(fx());
  const byName = Object.fromEntries(c.mcpServers.map(s => [s.name, s]));
  assert.equal(byName.pal.source, '~/.claude.json');
  assert.equal(byName.pal.transport, 'stdio');
  assert.equal(byName.local.source, 'settings.json');
  assert.equal(byName.ctx.source, 'plugin:alpha');
  assert.equal(byName.ctx.transport, 'http');
  assert.match(byName.projsrv.source, /^~\/\.claude\.json#project:/);
  assert.equal(byName.crm.source, 'plugin:gamma');
});

test('collectClaude: instruction files include global and project CLAUDE.md', () => {
  const c = collectClaude(fx());
  const names = c.instructionFiles.map(f => path.basename(path.dirname(f.path)) + '/' + path.basename(f.path));
  assert.ok(names.includes('.claude/CLAUDE.md'));
  assert.ok(names.includes('proj/CLAUDE.md'));
  const g = c.instructionFiles.find(f => f.path.endsWith('.claude/CLAUDE.md'));
  assert.ok(g.words > 40);
  assert.equal(g.tokensEst, Math.ceil(fs.readFileSync(g.path, 'utf8').length / 4));
});

test('collectClaude: clutter kinds', () => {
  const c = collectClaude(fx());
  const kinds = c.clutter.map(x => x.kind).sort();
  assert.deepEqual(kinds, ['backup', 'orphaned-plugin-version', 'stale-project-dir', 'temp-clone']);
  assert.ok(c.clutter.every(x => typeof x.bytes === 'number'));
});

test('collectClaude: missing root returns null', () => {
  assert.equal(collectClaude({ claudeRoot: '/nope/none', claudeJson: '/nope/x.json', cwd: '/nope', home: '/nope' }), null);
});

import { collectCodex } from '../scripts/lib/codex.mjs';

test('collectCodex: config facts and dead project', () => {
  const c = collectCodex(fx());
  assert.equal(c.config.model, 'gpt-6-astra');
  assert.equal(c.config.effort, 'high');
  assert.deepEqual(c.config.projects.map(p => p.exists), [true, false]);
});

test('collectCodex: skills exclude self, mcp servers from config.toml, hooks, instruction files', () => {
  const c = collectCodex(fx());
  assert.deepEqual(ids(c.skills), ['web-fetch-router']);
  assert.deepEqual(c.mcpServers.map(s => s.name).sort(), ['basic-memory', 'pal']);
  assert.equal(c.mcpServers[0].source, 'config.toml');
  assert.equal(c.hooks.UserPromptSubmit.length, 3);
  assert.equal(c.instructionFiles.length, 2);
});

test('collectCodex: clutter has backup and dead-project-entry', () => {
  const c = collectCodex(fx());
  assert.deepEqual(c.clutter.map(x => x.kind).sort(), ['backup', 'dead-project-entry']);
});

test('collectCodex: missing root returns null', () => {
  assert.equal(collectCodex({ codexRoot: '/nope/none', cwd: '/nope' }), null);
});

import { usageClaude, usageCodex } from '../scripts/lib/usage.mjs';

test('usageClaude counts skills, agents, mcp tools and servers inside the window only', async () => {
  const r = fx();
  const since = Date.now() - 30 * 86400e3;
  const u = await usageClaude(path.join(r.claudeRoot, 'projects'), since, collectClaude(r));
  assert.equal(u.sessions, 2); // s1 + stale project s9; s0 is 45 days old
  assert.deepEqual(u.skills, { 'alpha:brainstorming': 2, grilling: 1 });
  assert.deepEqual(u.agents, { Explore: 1 });
  assert.deepEqual(u.mcpTools, { mcp__pal__chat: 1, mcp__plugin_alpha_ctx__query: 1 });
  assert.deepEqual(u.mcpServers, { pal: 1, ctx: 1 });
  assert.equal(u.tools.Bash, 1);
});

test('usageCodex counts function calls and ignores skill paths in tool output', async () => {
  const r = fx();
  const since = Date.now() - 30 * 86400e3;
  const u = await usageCodex(path.join(r.codexRoot, 'sessions'), since, collectCodex(r));
  assert.equal(u.sessions, 1);
  assert.deepEqual(u.mcpServers, { pal: 2 });
  assert.deepEqual(u.mcpTools, { mcp__pal__chat: 1, pal__chat: 1 });
  assert.equal(u.tools.shell, 1);
  assert.deepEqual(u.skills, {});
});

test('usage on missing dirs is empty', async () => {
  const u = await usageClaude('/nope/none', 0);
  assert.equal(u.sessions, 0);
  assert.deepEqual(u.skills, {});
});

import { startupCost, extractFacts } from '../scripts/lib/analysis.mjs';

test('startupCost counts loaded skills only and sums instruction files', () => {
  const r = fx();
  const c = collectClaude(r), k = collectCodex(r);
  const cost = startupCost(c, k);
  const loaded = c.skills.filter(s => s.loaded);
  const expectSkills = loaded.reduce((n, s) => n + Math.ceil((s.id.length + s.description.length + s.path.length + 6) / 4), 0);
  assert.equal(cost.claude.skillList, expectSkills);
  assert.equal(cost.claude.mcpToolNames, null);
  assert.equal(cost.claude.instructionFiles, c.instructionFiles.reduce((n, f) => n + f.tokensEst, 0));
  assert.equal(cost.claude.hooks, 5);
  assert.equal(cost.claude.total, cost.claude.skillList + cost.claude.agentList + cost.claude.instructionFiles);
  assert.equal(cost.codex.hooks, 3);
  assert.equal(startupCost(null, k).claude, null);
});

test('extractFacts returns contextual candidates, not confirmed conflicts', () => {
  const r = fx();
  const facts = extractFacts(collectClaude(r), collectCodex(r));
  const by = Object.fromEntries(facts.map(f => [f.key, f]));
  assert.equal(by['codex.model'].config, 'gpt-6-astra');
  assert.equal(by['codex.model'].conflict, false);
  assert.equal(by['codex.model'].candidate, true);
  assert.equal(by['codex.model'].mentions[0].value, 'gpt-5.6-terra');
  assert.equal(by['codex.model'].mentions[0].line, 3);
  assert.equal(by['codex.effort'].conflict, false);
  assert.equal(by['codex.effort'].candidate, true);
  assert.equal(by['codex.effort'].mentions[0].value, 'medium');
  assert.deepEqual(by['mcp.unknown-server'].mentions.map(m => m.value), ['ghost']);
  assert.equal(by['mcp.unknown-server'].conflict, false);
  assert.equal(by['mcp.unknown-server'].candidate, true);
  assert.deepEqual(by['plugin.disabled-but-mentioned'].mentions.map(m => m.value), ['beta']);
});

import { execFileSync } from 'node:child_process';
import { runAudit } from '../scripts/audit.mjs';

const AUDIT = path.resolve('scripts/audit.mjs');

test('runAudit assembles the full inventory', async () => {
  const r = fx();
  const inv = await runAudit(r);
  assert.equal(inv.days, 30);
  assert.ok(inv.generatedAt);
  assert.equal(inv.host.platform, process.platform);
  assert.equal(inv.claude.skills.length, 9);
  assert.equal(inv.codex.config.model, 'gpt-6-astra');
  assert.equal(inv.usage.claude.skills['alpha:brainstorming'], 2);
  assert.equal(inv.usage.codex.mcpServers.pal, 2);
  assert.equal(inv.startupCost.claude.mcpToolNames, null);
  assert.ok(inv.facts.find(f => f.key === 'codex.model').candidate);
  assert.ok(Array.isArray(inv.warnings));
});

test('CLI writes inventory.json to --out and prints a summary', () => {
  const r = fx();
  const out = execFileSync('node', [AUDIT, '--home', r.home, '--out', r.out, '--cwd', r.cwd], { encoding: 'utf8' });
  assert.match(out, /inventory written to/);
  assert.match(out, /Claude Code\s+skills 8 loaded \(1 in disabled plugins\)/);
  assert.match(out, /Codex CLI\s+skills 1 enabled/);
  assert.match(out, /model gpt-6-astra \/ high/);
  const inv = JSON.parse(fs.readFileSync(path.join(r.out, 'inventory.json'), 'utf8'));
  assert.equal(inv.claude.plugins.length, 3);
});

test('CLI --json prints inventory and writes nothing', () => {
  const r = fx();
  const out = execFileSync('node', [AUDIT, '--home', r.home, '--out', r.out, '--cwd', r.cwd, '--json'], { encoding: 'utf8' });
  const inv = JSON.parse(out);
  assert.equal(inv.codex.skills[0].id, 'web-fetch-router');
  assert.equal(fs.existsSync(path.join(r.out, 'inventory.json')), false);
});

test('CLI with no harness dirs still exits 0 with null sections', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-empty-'));
  const out = execFileSync('node', [AUDIT, '--home', tmp, '--out', path.join(tmp, 'out'), '--cwd', tmp, '--json'], { encoding: 'utf8' });
  const inv = JSON.parse(out);
  assert.equal(inv.claude, null);
  assert.equal(inv.codex, null);
  assert.equal(inv.startupCost.claude, null);
});
