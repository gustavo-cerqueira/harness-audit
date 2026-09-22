import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildFixture } from './helpers/fixture.mjs';
import { runAudit } from '../scripts/audit.mjs';

test('actual inventory feeds a scoped CLI batch and undo restores all original contents', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-workflow-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const r = buildFixture(tmp);
  const inventory = await runAudit(r);
  const plugin = inventory.claude.plugins.find(p => p.name === 'alpha');
  const claudeServer = inventory.claude.mcpServers.find(s => s.name === 'pal');
  const codexServer = inventory.codex.mcpServers.find(s => s.name === 'pal');
  const hook = inventory.claude.hooks.PreToolUse[0];
  const skill = inventory.claude.skills.find(s => s.id === 'grill-me');
  const clutter = inventory.claude.clutter.find(c => c.kind === 'backup');
  const config = path.join(r.codexRoot, 'config.toml');
  const items = [
    { action: 'disable-plugin', harness: 'claude', source: 'plugin:alpha', target: 'alpha', enabledSource: plugin.enabledSource, enabledPath: plugin.enabledPath },
    { action: 'remove-mcp', harness: 'claude', source: claudeServer.source, target: claudeServer.name, path: claudeServer.path },
    { action: 'remove-mcp', harness: 'codex', source: codexServer.source, target: codexServer.name, path: codexServer.path },
    { action: 'remove-hook', harness: 'claude', source: hook.source, target: hook.command, path: hook.path, event: 'PreToolUse', matcher: hook.matcher },
    { action: 'remove-skill', harness: 'claude', source: skill.source, path: path.dirname(skill.path) },
    { action: 'delete-clutter', harness: 'claude', source: 'claude.clutter', path: clutter.path },
    { action: 'prune-codex-projects', harness: 'codex', source: 'codex.clutter', path: config, paths: inventory.codex.config.projects.filter(p => !p.exists).map(p => p.path) },
  ].map((item, i) => ({ ...item, id: `P${i + 1}`, reason: 'Synthetic approved workflow check', manual: false }));
  const originals = [path.join(r.claudeRoot, 'settings.json'), r.claudeJson, config, skill.path, clutter.path, path.join(r.claudeRoot, 'CLAUDE.md')];
  const before = new Map(originals.map(p => [p, fs.readFileSync(p, 'utf8')]));
  fs.mkdirSync(r.out, { recursive: true });
  fs.writeFileSync(path.join(r.out, 'inventory.json'), JSON.stringify(inventory));
  const planPath = path.join(r.out, 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify({ generatedAt: inventory.generatedAt, cwd: inventory.cwd, items }));
  const apply = path.resolve('scripts/apply.mjs');
  const output = execFileSync(process.execPath, [apply, '--plan', planPath, '--ids', items.map(i => i.id).join(','), '--yes', '--home', r.home, '--cwd', r.cwd, '--out', r.out], { encoding: 'utf8' });
  assert.equal(JSON.parse(fs.readFileSync(originals[0])).enabledPlugins['alpha@mk'], false);
  assert.equal(JSON.parse(fs.readFileSync(r.claudeJson)).mcpServers.pal, undefined);
  assert.equal(fs.existsSync(skill.path), false);
  assert.equal(fs.existsSync(clutter.path), false);
  assert.equal(fs.readFileSync(config, 'utf8').includes('[mcp_servers.pal]'), false);
  assert.equal(fs.readFileSync(config, 'utf8').includes('/nope/dead'), false);
  const backup = /^backup: (.+)$/m.exec(output)?.[1];
  assert.ok(backup);
  execFileSync(process.execPath, [apply, '--undo', path.basename(backup), '--out', r.out], { encoding: 'utf8' });
  for (const [p, contents] of before) assert.equal(fs.readFileSync(p, 'utf8'), contents, p);
});

test('apply refuses replacement skill contents even within the 24-hour approval window', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-drift-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const r = buildFixture(tmp);
  const inventory = await runAudit(r);
  const skill = inventory.claude.skills.find(s => s.id === 'grill-me');
  const item = { id: 'P1', action: 'remove-skill', harness: 'claude', source: skill.source, path: path.dirname(skill.path), reason: 'approved old version', manual: false };
  fs.mkdirSync(r.out, { recursive: true });
  fs.writeFileSync(path.join(r.out, 'inventory.json'), JSON.stringify(inventory));
  const plan = path.join(r.out, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify({ generatedAt: inventory.generatedAt, cwd: r.cwd, items: [item] }));
  fs.writeFileSync(skill.path, 'replacement installed after approval');
  const result = spawnSync(process.execPath, [path.resolve('scripts/apply.mjs'), '--plan', plan, '--ids', 'P1', '--yes', '--home', r.home, '--cwd', r.cwd, '--out', r.out], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /target changed since the audit/);
  assert.equal(fs.readFileSync(skill.path, 'utf8'), 'replacement installed after approval');
  assert.equal(fs.existsSync(path.join(r.out, 'backups')), false);
});

async function approvedClaudeJsonServer(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-claude-json-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const r = buildFixture(tmp);
  const inventory = await runAudit(r);
  const server = inventory.claude.mcpServers.find(s => s.name === 'pal' && s.source === '~/.claude.json');
  const item = { id: 'P1', action: 'remove-mcp', harness: 'claude', source: server.source, target: server.name, path: server.path, reason: 'approved', manual: false };
  fs.mkdirSync(r.out, { recursive: true });
  fs.writeFileSync(path.join(r.out, 'inventory.json'), JSON.stringify(inventory));
  const plan = path.join(r.out, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify({ generatedAt: inventory.generatedAt, cwd: r.cwd, items: [item] }));
  // Claude Code saves ~/.claude.json with a fresh file every few seconds while it runs.
  const rewrite = mutate => {
    const config = JSON.parse(fs.readFileSync(r.claudeJson, 'utf8'));
    mutate(config);
    fs.writeFileSync(`${r.claudeJson}.tmp`, JSON.stringify(config, null, 2));
    fs.renameSync(`${r.claudeJson}.tmp`, r.claudeJson);
  };
  const apply = () => spawnSync(process.execPath, [path.resolve('scripts/apply.mjs'), '--plan', plan, '--ids', 'P1', '--yes', '--home', r.home, '--cwd', r.cwd, '--out', r.out], { encoding: 'utf8' });
  return { r, rewrite, apply };
}

test('apply removes an approved ~/.claude.json server after Claude Code rewrites unrelated state', async t => {
  const { r, rewrite, apply } = await approvedClaudeJsonServer(t);
  rewrite(config => { config.numStartups = 42; });
  const result = apply();
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(fs.readFileSync(r.claudeJson, 'utf8'));
  assert.equal(config.mcpServers.pal, undefined);
  assert.equal(config.numStartups, 42);
});

test('apply refuses an approved ~/.claude.json server whose own entry changed', async t => {
  const { r, rewrite, apply } = await approvedClaudeJsonServer(t);
  rewrite(config => { config.mcpServers.pal.args = ['replacement']; });
  const result = apply();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /target changed since the audit/);
  assert.deepEqual(JSON.parse(fs.readFileSync(r.claudeJson, 'utf8')).mcpServers.pal.args, ['replacement']);
});
