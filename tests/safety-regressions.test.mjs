import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildFixture } from './helpers/fixture.mjs';
import { createBackup, restoreBackup } from '../scripts/lib/backup.mjs';
import { applyItem } from '../scripts/lib/actions.mjs';
import { parseToml, removeTable } from '../scripts/lib/toml.mjs';

const APPLY = path.resolve('scripts/apply.mjs');
const fx = () => buildFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'ha-safety-')));

test('backup assigns distinct storage to paths that differ by a literal double underscore', () => {
  const r = fx();
  const first = path.join(r.claudeRoot, 'foo__bar');
  const second = path.join(r.claudeRoot, 'foo', 'bar');
  fs.mkdirSync(path.dirname(second), { recursive: true });
  fs.writeFileSync(first, 'first');
  fs.writeFileSync(second, 'second');
  const backup = createBackup(r.out, 'collision');
  backup.move(first);
  backup.move(second);
  backup.finish();

  const manifest = JSON.parse(fs.readFileSync(path.join(r.out, 'backups', 'collision', 'manifest.json')));
  assert.notEqual(manifest.entries[0].stored, manifest.entries[1].stored);
  assert.deepEqual(restoreBackup(r.out, 'collision', { force: true }).failed, []);
  assert.equal(fs.readFileSync(first, 'utf8'), 'first');
  assert.equal(fs.readFileSync(second, 'utf8'), 'second');
});

test('backup journal recovers a moved directory when process ends before finish', () => {
  const r = fx();
  const skill = path.join(r.claudeRoot, 'skills', 'grill-me');
  const backup = createBackup(r.out, 'interrupted');
  backup.move(skill);

  assert.equal(fs.existsSync(skill), false);
  const recovered = restoreBackup(r.out, 'interrupted');
  assert.deepEqual(recovered.failed, []);
  assert.equal(fs.existsSync(path.join(skill, 'SKILL.md')), true);
});

test('undo reports an immediate post-apply edit as a conflict', () => {
  const r = fx();
  const settings = path.join(r.claudeRoot, 'settings.json');
  const backup = createBackup(r.out, 'immediate-edit');
  backup.add(settings);
  fs.writeFileSync(settings, '{"apply":true}');
  backup.markApplied(settings);
  backup.finish();
  fs.writeFileSync(settings, '{"userEditImmediatelyAfterApply":true}');

  const restored = restoreBackup(r.out, 'immediate-edit');
  assert.deepEqual(restored.conflicts, [settings]);
  assert.equal(fs.readFileSync(settings, 'utf8'), '{"userEditImmediatelyAfterApply":true}');
});

test('undo preserves a path deleted after apply until force is explicit', () => {
  const r = fx();
  const settings = path.join(r.claudeRoot, 'settings.json');
  const backup = createBackup(r.out, 'deleted-after-apply');
  backup.add(settings);
  fs.writeFileSync(settings, '{"apply":true}');
  backup.markApplied(settings);
  backup.finish();
  fs.rmSync(settings);

  assert.deepEqual(restoreBackup(r.out, 'deleted-after-apply').conflicts, [settings]);
  assert.equal(fs.existsSync(settings), false);
});

test('undo never deletes a pre-existing temporary-looking file', () => {
  const r = fx();
  const settings = path.join(r.claudeRoot, 'settings.json');
  const temp = settings + '.harness-audit-restore';
  const backup = createBackup(r.out, 'temp-name');
  backup.add(settings);
  fs.writeFileSync(settings, '{"apply":true}');
  backup.markApplied(settings);
  backup.finish();
  fs.writeFileSync(temp, 'user file');

  restoreBackup(r.out, 'temp-name', { force: true });
  assert.equal(fs.readFileSync(temp, 'utf8'), 'user file');
});

test('creating a second backup with the same stamp refuses before entries can mix', () => {
  const r = fx();
  createBackup(r.out, 'same-stamp');
  assert.throws(() => createBackup(r.out, 'same-stamp'), /already exists/);
});

test('removeTable preserves a valid quoted table key containing a closing bracket', () => {
  const text = '[mcp_servers.foo]\ncommand = "foo"\n\n[projects."/tmp/a]b"]\ntrust_level = "trusted"\n';
  assert.equal(removeTable(text, ['mcp_servers', 'foo']), '[projects."/tmp/a]b"]\ntrust_level = "trusted"\n');
});

test('removeTable removes non-contiguous child tables without removing a sibling', () => {
  const text = '[mcp_servers.foo]\ncommand = "foo"\n\n[mcp_servers.bar]\ncommand = "bar"\n\n[mcp_servers.foo.env]\nKEY = "v"\n';
  assert.equal(removeTable(text, ['mcp_servers', 'foo']), '[mcp_servers.bar]\ncommand = "bar"\n');
});

test('parseToml keeps a quoted __proto__ table key as data', () => {
  const toml = parseToml('["__proto__"]\nvalue = "safe"\n');
  assert.equal(Object.hasOwn(toml, '__proto__'), true);
  assert.equal(toml.__proto__.value, 'safe');
});

test('remove-mcp refuses unsupported TOML before changing config', () => {
  const r = fx();
  const config = path.join(r.codexRoot, 'config.toml');
  const before = '[mcp_servers.pal]\ncommand = "pal"\ninline = { unsafe = true }\n';
  fs.writeFileSync(config, before);
  assert.throws(
    () => applyItem({ id: 'P1', action: 'remove-mcp', target: 'pal', path: config, harness: 'codex', source: 'config.toml', reason: 'x', manual: false }, r, createBackup(r.out, 'unsafe-toml')),
    /unsupported TOML/
  );
  assert.equal(fs.readFileSync(config, 'utf8'), before);
});

test('path actions refuse instructions, harness-audit itself, and non-user sources', () => {
  const r = fx();
  const backup = createBackup(r.out, 'scope');
  assert.throws(
    () => applyItem({ id: 'P1', action: 'delete-clutter', path: path.join(r.claudeRoot, 'CLAUDE.md'), harness: 'claude', source: 'claude.clutter', reason: 'x', manual: false }, r, backup),
    /instruction file/
  );
  assert.throws(
    () => applyItem({ id: 'P2', action: 'remove-skill', path: path.join(r.claudeRoot, 'skills', 'harness-audit'), harness: 'claude', source: 'user', reason: 'x', manual: false }, r, backup),
    /harness-audit/
  );
  assert.throws(
    () => applyItem({ id: 'P3', action: 'remove-skill', path: path.join(r.claudeRoot, 'plugins', 'cache', 'mk', 'alpha', 'v1', 'skills', 'review'), harness: 'claude', source: 'plugin:alpha', reason: 'x', manual: false }, r, backup),
    /unsupported source/
  );
});

test('disable-plugin refuses a project-scoped enabled setting', () => {
  const r = fx();
  assert.throws(
    () => applyItem({ id: 'P5', action: 'disable-plugin', target: 'alpha', harness: 'claude', source: 'plugin:alpha', enabledSource: 'project:.claude/settings.json', enabledPath: path.join(r.cwd, '.claude', 'settings.json'), reason: 'x', manual: false }, r, createBackup(r.out, 'project-plugin')),
    /unsupported enabled source/
  );
});

test('remove-hook only removes the exact event and matcher finding', () => {
  const r = fx();
  const settings = path.join(r.claudeRoot, 'settings.json');
  const hooks = JSON.parse(fs.readFileSync(settings, 'utf8')).hooks;
  hooks.PostToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard2.js' }] });
  fs.writeFileSync(settings, JSON.stringify({ enabledPlugins: {}, hooks }));

  applyItem({ id: 'P4', action: 'remove-hook', target: 'node guard2.js', event: 'PreToolUse', matcher: 'Bash', path: settings, harness: 'claude', source: 'settings.json', reason: 'x', manual: false }, r, createBackup(r.out, 'hook-scope'));
  const remaining = JSON.parse(fs.readFileSync(settings, 'utf8')).hooks;
  assert.deepEqual(remaining.PreToolUse[0].hooks.map(h => h.command), ['node guard1.js']);
  assert.deepEqual(remaining.PostToolUse.at(-1).hooks.map(h => h.command), ['node guard2.js']);
});

test('cli refuses a stale plan envelope before applying any item', () => {
  const r = fx();
  fs.mkdirSync(r.out, { recursive: true });
  const old = new Date(Date.now() - 25 * 3600e3).toISOString();
  const plan = path.join(r.out, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify({ generatedAt: old, cwd: r.cwd, items: [{ id: 'P1', action: 'disable-plugin', target: 'alpha', harness: 'claude', source: 'plugin:alpha', reason: 'x', manual: false }] }));
  fs.writeFileSync(path.join(r.out, 'inventory.json'), JSON.stringify({ generatedAt: old, cwd: r.cwd, claude: { plugins: [{ name: 'alpha', source: 'plugin:alpha' }] } }));

  const result = spawnSync('node', [APPLY, '--plan', plan, '--ids', 'P1', '--yes', '--home', r.home, '--out', r.out, '--cwd', r.cwd], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stdout + result.stderr, /stale/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.claudeRoot, 'settings.json'), 'utf8')).enabledPlugins['alpha@mk'], true);
});

test('journal recovers an atomic move interrupted before captured state was persisted', () => {
  const r = fx();
  const original = path.join(r.claudeRoot, 'skills', 'grill-me');
  const backup = createBackup(r.out, 'between-rename-and-journal');
  backup.move(original);
  const journalPath = path.join(backup.dir, 'journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath));
  journal.entries[0].captured = false;
  journal.entries[0].applied = null;
  fs.writeFileSync(journalPath, JSON.stringify(journal));
  assert.deepEqual(restoreBackup(r.out, 'between-rename-and-journal').failed, []);
  assert.ok(fs.existsSync(original));
});

test('legacy manifests still restore moves and require force for unverifiable copied files', () => {
  const r = fx();
  const original = path.join(r.claudeRoot, 'legacy');
  const dir = path.join(r.out, 'backups', 'legacy-format');
  fs.mkdirSync(dir, { recursive: true });
  const stored = path.join(dir, 'legacy-copy');
  fs.writeFileSync(stored, 'original');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ finishedAt: Date.now(), entries: [{ original, stored, mode: 'move', mtimeMs: 0 }] }));
  assert.deepEqual(restoreBackup(r.out, 'legacy-format').failed, []);
  assert.equal(fs.readFileSync(original, 'utf8'), 'original');
  fs.writeFileSync(stored, 'before');
  fs.writeFileSync(original, 'current');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ finishedAt: Date.now(), entries: [{ original, stored, mode: 'copy', mtimeMs: 0 }] }));
  assert.deepEqual(restoreBackup(r.out, 'legacy-format').conflicts, [original]);
  assert.deepEqual(restoreBackup(r.out, 'legacy-format', { force: true }).failed, []);
  assert.equal(fs.readFileSync(original, 'utf8'), 'before');
});

test('a failed backup capture cannot be reused as if the original were protected', () => {
  const r = fx();
  const settings = path.join(r.claudeRoot, 'settings.json');
  const backup = createBackup(r.out, 'failed-copy');
  const copy = fs.cpSync;
  try {
    fs.cpSync = () => { throw new Error('fixture copy failure'); };
    assert.throws(() => backup.add(settings), /fixture copy failure/);
  } finally { fs.cpSync = copy; }
  assert.throws(() => backup.add(settings), /capture did not complete/);
});

test('disable-plugin refuses ambiguous marketplaces or overrides added after the inventory', () => {
  const r = fx();
  const settings = path.join(r.claudeRoot, 'settings.json');
  const item = { id: 'P1', action: 'disable-plugin', target: 'alpha', harness: 'claude', source: 'plugin:alpha', enabledSource: 'settings.json', enabledPath: settings };
  const original = fs.readFileSync(settings, 'utf8');
  const changed = JSON.parse(original);
  changed.enabledPlugins['alpha@another-marketplace'] = true;
  fs.writeFileSync(settings, JSON.stringify(changed));
  assert.throws(() => applyItem(item, r, createBackup(r.out, 'ambiguous-marketplace')), /multiple marketplaces/);
  assert.equal(JSON.parse(fs.readFileSync(settings)).enabledPlugins['alpha@mk'], true);
  fs.writeFileSync(settings, original);
  fs.mkdirSync(path.join(r.cwd, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(r.cwd, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'alpha@mk': true } }));
  assert.throws(() => applyItem(item, r, createBackup(r.out, 'new-override')), /current override/);
  assert.equal(fs.readFileSync(settings, 'utf8'), original);
});
