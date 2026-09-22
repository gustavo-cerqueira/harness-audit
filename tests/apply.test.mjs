// tests/apply.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { buildFixture } from './helpers/fixture.mjs';
import { createBackup, restoreBackup, listBackups } from '../scripts/lib/backup.mjs';
import { applyItem } from '../scripts/lib/actions.mjs';
import { parseToml } from '../scripts/lib/toml.mjs';
import { snapshotTargets } from '../scripts/lib/snapshot.mjs';

const APPLY = path.resolve('scripts/apply.mjs');
const fx = () => buildFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'ha-apply-')));
const fxWithTmp = () => { const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-apply-')); return { r: buildFixture(tmpDir), tmpDir }; };
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const rootFlags = r => ['--home', r.home, '--out', r.out, '--cwd', r.cwd];

function writePlan(r, items) {
  fs.mkdirSync(r.out, { recursive: true });
  const p = path.join(r.out, 'plan.json');
  const normalized = items.map(item => {
    if (item.action === 'disable-plugin') return { ...item, source: item.source ?? `plugin:${item.target}`, enabledSource: item.enabledSource ?? 'settings.json', enabledPath: item.enabledPath ?? path.join(r.claudeRoot, 'settings.json') };
    if (item.action === 'remove-skill' || item.action === 'remove-agent') return { ...item, source: item.source ?? 'user' };
    if (item.action === 'remove-mcp') {
      const source = item.source ?? (item.harness === 'codex' ? 'config.toml' : '~/.claude.json');
      const paths = { '~/.claude.json': r.claudeJson, 'settings.json': path.join(r.claudeRoot, 'settings.json'), 'settings.local.json': path.join(r.claudeRoot, 'settings.local.json'), 'config.toml': path.join(r.codexRoot, 'config.toml') };
      return { ...item, source, path: item.path ?? paths[source] };
    }
    if (item.action === 'remove-hook') return { ...item, source: item.source ?? 'settings.json', event: item.event ?? 'PreToolUse', matcher: item.matcher ?? 'Bash' };
    if (item.action === 'delete-clutter') return { ...item, source: item.source ?? `${item.harness}.clutter` };
    if (item.action === 'prune-codex-projects') return { ...item, source: item.source ?? `${item.harness}.clutter`, paths: item.paths ?? ['/nope/dead'] };
    return item;
  });
  const generatedAt = new Date().toISOString();
  const inventory = { generatedAt, cwd: r.cwd, claude: { root: r.claudeRoot, plugins: [], skills: [], agents: [], mcpServers: [], hooks: {}, clutter: [] }, codex: { root: r.codexRoot, plugins: [], skills: [], agents: [], mcpServers: [], hooks: {}, clutter: [] } };
  for (const item of normalized) {
    const h = inventory[item.harness];
    if (item.action === 'disable-plugin') h.plugins.push({ name: item.target, enabledSource: item.enabledSource, enabledPath: item.enabledPath });
    if (item.action === 'remove-skill') h.skills.push({ source: item.source, path: path.join(item.path, 'SKILL.md') });
    if (item.action === 'remove-agent') h.agents.push({ source: item.source, path: item.path });
    if (item.action === 'remove-mcp') h.mcpServers.push({ name: item.target, source: item.source, path: item.path });
    if (item.action === 'remove-hook') (h.hooks[item.event] ??= []).push({ command: item.target, matcher: item.matcher, source: item.source, path: item.path });
    if (item.action === 'delete-clutter') h.clutter.push({ path: item.path });
    if (item.action === 'prune-codex-projects') for (const dead of item.paths) h.clutter.push({ kind: 'dead-project-entry', path: `${path.join(r.codexRoot, 'config.toml')}#projects.${dead}` });
  }
  inventory.targetSnapshots = snapshotTargets(inventory.claude, inventory.codex, []);
  fs.writeFileSync(p, JSON.stringify({ generatedAt, cwd: r.cwd, items: normalized }));
  fs.writeFileSync(path.join(r.out, 'inventory.json'), JSON.stringify(inventory));
  return p;
}

test('backup: add copies, move moves, manifest lists both, restore brings back', () => {
  const r = fx();
  const settings = path.join(r.claudeRoot, 'settings.json');
  const skillDir = path.join(r.claudeRoot, 'skills', 'grill-me');
  const before = fs.readFileSync(settings, 'utf8');
  const b = createBackup(r.out, 'stamp-1');
  b.add(settings); b.move(skillDir); b.finish();
  assert.equal(fs.existsSync(skillDir), false);
  fs.writeFileSync(settings, '{}');
  const m = readJson(path.join(r.out, 'backups', 'stamp-1', 'manifest.json'));
  assert.deepEqual(m.entries.map(e => e.mode), ['copy', 'move']);
  const res = restoreBackup(r.out, 'stamp-1', { force: true });
  assert.equal(fs.readFileSync(settings, 'utf8'), before);
  assert.equal(fs.existsSync(path.join(skillDir, 'SKILL.md')), true);
  assert.equal(res.restored.length, 2);
  assert.equal(listBackups(r.out)[0].stamp, 'stamp-1');
});

test('backup: restore refuses a file changed after the backup unless force', () => {
  const r = fx();
  const settings = path.join(r.claudeRoot, 'settings.json');
  const b = createBackup(r.out, 'stamp-2');
  b.add(settings); b.finish();
  const later = new Date(Date.now() + 5000);
  fs.writeFileSync(settings, '{"changed":true}');
  fs.utimesSync(settings, later, later);
  const res = restoreBackup(r.out, 'stamp-2', { force: false });
  assert.deepEqual(res.conflicts, [settings]);
  assert.equal(readJson(settings).changed, true);
});

test('backup: restore refuses a move entry whose original path was recreated, unless force', () => {
  const r = fx();
  const skillDir = path.join(r.claudeRoot, 'skills', 'grill-me');
  const b = createBackup(r.out, 'stamp-move');
  b.move(skillDir); b.finish();
  assert.equal(fs.existsSync(skillDir), false);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'NEW.md'), 'new content');
  const res = restoreBackup(r.out, 'stamp-move', { force: false });
  assert.deepEqual(res.conflicts, [skillDir]);
  assert.equal(fs.existsSync(path.join(skillDir, 'NEW.md')), true);
  const stored = readJson(path.join(r.out, 'backups', 'stamp-move', 'manifest.json')).entries[0].stored;
  assert.equal(fs.existsSync(path.join(stored, 'SKILL.md')), true);
  const forced = restoreBackup(r.out, 'stamp-move', { force: true });
  assert.deepEqual(forced.restored, [skillDir]);
  assert.equal(fs.existsSync(path.join(skillDir, 'SKILL.md')), true);
});

test('actions: disable-plugin flips only the target flag', () => {
  const r = fx();
  const b = createBackup(r.out, 's');
  const res = applyItem({ id: 'P1', action: 'disable-plugin', target: 'alpha', harness: 'claude', source: 'plugin:alpha', enabledSource: 'settings.json', enabledPath: path.join(r.claudeRoot, 'settings.json'), manual: false }, r, b);
  const s = readJson(path.join(r.claudeRoot, 'settings.json'));
  assert.equal(s.enabledPlugins['alpha@mk'], false);
  assert.equal(s.enabledPlugins['beta@mk'], false);
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.deepEqual(res.changed, [path.join(r.claudeRoot, 'settings.json')]);
});

test('actions: disable-plugin re-applied after already disabled is idempotent', () => {
  const r = fx();
  const b = createBackup(r.out, 's');
  applyItem({ id: 'P1', action: 'disable-plugin', target: 'alpha', harness: 'claude', source: 'plugin:alpha', enabledSource: 'settings.json', enabledPath: path.join(r.claudeRoot, 'settings.json'), manual: false }, r, b);
  const res = applyItem({ id: 'P1b', action: 'disable-plugin', target: 'alpha', harness: 'claude', source: 'plugin:alpha', enabledSource: 'settings.json', enabledPath: path.join(r.claudeRoot, 'settings.json'), manual: false }, r, b);
  assert.deepEqual(res, { changed: [], note: 'already disabled' });
});

test('actions: disable-plugin throws when no matching key exists at all', () => {
  const r = fx();
  const b = createBackup(r.out, 's');
  assert.throws(
    () => applyItem({ id: 'PX', action: 'disable-plugin', target: 'nope', harness: 'claude', source: 'plugin:nope', enabledSource: 'settings.json', enabledPath: path.join(r.claudeRoot, 'settings.json'), manual: false }, r, b),
    /plugin nope not found in settings\.json/
  );
});

test('actions: remove-mcp claude removes from ~/.claude.json, codex removes toml block', () => {
  const r = fx();
  const b = createBackup(r.out, 's');
  applyItem({ id: 'P2', action: 'remove-mcp', target: 'pal', path: r.claudeJson, harness: 'claude', source: '~/.claude.json', manual: false }, r, b);
  assert.equal(readJson(r.claudeJson).mcpServers.pal, undefined);
  assert.ok(readJson(r.claudeJson).projects);
  applyItem({ id: 'P3', action: 'remove-mcp', target: 'pal', path: path.join(r.codexRoot, 'config.toml'), harness: 'codex', source: 'config.toml', manual: false }, r, b);
  const toml = fs.readFileSync(path.join(r.codexRoot, 'config.toml'), 'utf8');
  assert.doesNotMatch(toml, /mcp_servers\.pal/);
  assert.match(toml, /\[mcp_servers\.basic-memory\]/);
  assert.equal(parseToml(toml).model, 'gpt-6-astra');
});

test('actions: remove-mcp claude removes only the source-qualified key', () => {
  const r = fx();
  const settingsPath = path.join(r.claudeRoot, 'settings.json');
  const settings = readJson(settingsPath);
  settings.mcpServers.pal = { command: 'uvx', args: ['pal-mcp'] };
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
  const b = createBackup(r.out, 's');
  const res = applyItem({ id: 'P2b', action: 'remove-mcp', target: 'pal', path: r.claudeJson, harness: 'claude', source: '~/.claude.json', manual: false }, r, b);
  assert.equal(res.changed.length, 1);
  assert.equal(readJson(r.claudeJson).mcpServers.pal, undefined);
  assert.ok(readJson(settingsPath).mcpServers.pal);
});

test('actions: remove-skill given the SKILL.md path moves the whole directory', () => {
  const r = fx();
  const b = createBackup(r.out, 's');
  const skillDir = path.join(r.claudeRoot, 'skills', 'grilling');
  const skillMd = path.join(skillDir, 'SKILL.md');
  const res = applyItem({ id: 'P4a', action: 'remove-skill', path: skillMd, harness: 'claude', source: 'user', manual: false }, r, b);
  assert.equal(fs.existsSync(skillDir), false);
  assert.deepEqual(res.changed, [skillDir]);
});

test('actions: remove-skill and delete-clutter move to backup; remove-hook drops the command', () => {
  const r = fx();
  const b = createBackup(r.out, 's');
  const skill = path.join(r.claudeRoot, 'skills', 'grilling');
  applyItem({ id: 'P4', action: 'remove-skill', path: skill, harness: 'claude', source: 'user', manual: false }, r, b);
  assert.equal(fs.existsSync(skill), false);
  const bak = path.join(r.claudeRoot, 'settings.json.bak-1');
  applyItem({ id: 'P5', action: 'delete-clutter', path: bak, harness: 'claude', source: 'claude.clutter', manual: false }, r, b);
  assert.equal(fs.existsSync(bak), false);
  const settings = path.join(r.claudeRoot, 'settings.json');
  applyItem({ id: 'P6', action: 'remove-hook', target: 'node guard2.js', event: 'PreToolUse', matcher: 'Bash', path: settings, harness: 'claude', source: 'settings.json', manual: false }, r, b);
  const s = readJson(settings);
  assert.deepEqual(s.hooks.PreToolUse.flatMap(g => g.hooks.map(h => h.command)), ['node guard1.js', 'node guard3.js']);
  b.finish();
  assert.equal(fs.existsSync(path.join(r.out, 'backups', 's', 'manifest.json')), true);
});

test('actions: prune-codex-projects removes only dead entries', () => {
  const r = fx();
  const b = createBackup(r.out, 's');
  applyItem({ id: 'P7', action: 'prune-codex-projects', harness: 'codex', source: 'codex.clutter', paths: ['/nope/dead'], manual: false }, r, b);
  const t = parseToml(fs.readFileSync(path.join(r.codexRoot, 'config.toml'), 'utf8'));
  assert.deepEqual(Object.keys(t.projects), [r.cwd]);
});

test('actions: unknown action throws', () => {
  const r = fx();
  assert.throws(() => applyItem({ id: 'X', action: 'nuke', manual: false }, r, createBackup(r.out, 's')), /unknown action/);
});

test('actions: applyItem refuses a path outside the harness roots', () => {
  const { r, tmpDir } = fxWithTmp();
  const outside = path.join(tmpDir, 'outside-dir');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'f.txt'), 'x');
  const b = createBackup(r.out, 's');
  assert.throws(
    () => applyItem({ id: 'X', action: 'remove-skill', path: outside, harness: 'claude', source: 'user', manual: false }, r, b),
    /outside harness roots/
  );
  assert.equal(fs.existsSync(outside), true);
});

test('actions: applyItem refuses a symlink whose target escapes the harness roots', () => {
  const { r, tmpDir } = fxWithTmp();
  const outside = path.join(tmpDir, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  const outsideFile = path.join(outside, 'file.txt');
  fs.writeFileSync(outsideFile, 'x');
  fs.symlinkSync(outside, path.join(r.claudeRoot, 'skills', 'linked'), 'dir');
  const b = createBackup(r.out, 's');
  assert.throws(
    () => applyItem({ id: 'X', action: 'delete-clutter', path: path.join(r.claudeRoot, 'skills', 'linked', 'file.txt'), harness: 'claude', source: 'claude.clutter', manual: false }, r, b),
    /outside harness roots/
  );
  assert.equal(fs.existsSync(outsideFile), true);
});

test('backup: restoreBackup is fail-safe when a stored copy is missing', () => {
  const r = fx();
  const settings = path.join(r.claudeRoot, 'settings.json');
  const claudeMd = path.join(r.claudeRoot, 'CLAUDE.md');
  const settingsBefore = fs.readFileSync(settings, 'utf8');
  const b = createBackup(r.out, 'stamp-3');
  b.add(settings); b.add(claudeMd); b.finish();
  const manifest = readJson(path.join(r.out, 'backups', 'stamp-3', 'manifest.json'));
  const claudeMdEntry = manifest.entries.find(e => e.original === claudeMd);
  fs.rmSync(claudeMdEntry.stored);
  fs.writeFileSync(settings, '{"changed":true}');
  fs.writeFileSync(claudeMd, 'still here');
  const res = restoreBackup(r.out, 'stamp-3', { force: true });
  assert.deepEqual(res.restored, [settings]);
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].original, claudeMd);
  assert.equal(fs.readFileSync(settings, 'utf8'), settingsBefore);
  assert.equal(fs.readFileSync(claudeMd, 'utf8'), 'still here');
});

test('cli: non-TTY without --yes exits 2 and changes nothing', () => {
  const r = fx();
  const plan = writePlan(r, [{ id: 'P1', action: 'disable-plugin', target: 'alpha', harness: 'claude', reason: 'x', manual: false }]);
  const res = spawnSync('node', [APPLY, '--plan', plan, '--ids', 'P1', ...rootFlags(r)], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  assert.equal(res.status, 2);
  assert.match(res.stderr + res.stdout, /refused/);
  assert.equal(readJson(path.join(r.claudeRoot, 'settings.json')).enabledPlugins['alpha@mk'], true);
});

test('cli: --yes applies selected ids, prints undo, and --undo restores', () => {
  const r = fx();
  const settings = path.join(r.claudeRoot, 'settings.json');
  const plan = writePlan(r, [
    { id: 'P1', action: 'disable-plugin', target: 'alpha', harness: 'claude', reason: 'x', manual: false },
    { id: 'P2', action: 'remove-skill', path: path.join(r.claudeRoot, 'skills', 'grilling'), harness: 'claude', reason: 'x', manual: false },
    { id: 'P3', action: 'edit-instructions', path: path.join(r.claudeRoot, 'CLAUDE.md'), harness: 'claude', reason: 'fix model name', manual: true },
  ]);
  const out = execFileSync('node', [APPLY, '--plan', plan, '--ids', 'P1,P2', '--yes', ...rootFlags(r)], { encoding: 'utf8' });
  assert.match(out, /P1 disable-plugin alpha/);
  assert.match(out, /P2 remove-skill/);
  const stamp = /--undo (\S+)/.exec(out)[1];
  assert.equal(readJson(settings).enabledPlugins['alpha@mk'], false);
  assert.equal(fs.existsSync(path.join(r.claudeRoot, 'skills', 'grilling')), false);
  execFileSync('node', [APPLY, '--undo', stamp, ...rootFlags(r)], { encoding: 'utf8' });
  assert.equal(readJson(settings).enabledPlugins['alpha@mk'], true);
  assert.equal(fs.existsSync(path.join(r.claudeRoot, 'skills', 'grilling', 'SKILL.md')), true);
});

test('cli: one item failing does not abort the batch; the rest still apply and undo covers them', () => {
  const r = fx();
  const skill = path.join(r.claudeRoot, 'skills', 'grilling');
  const plan = writePlan(r, [
    { id: 'P1', action: 'disable-plugin', target: 'nope', harness: 'claude', reason: 'x', manual: false },
    { id: 'P2', action: 'remove-skill', path: skill, harness: 'claude', reason: 'x', manual: false },
  ]);
  const res = spawnSync('node', [APPLY, '--plan', plan, '--ids', 'P1,P2', '--yes', ...rootFlags(r)], { encoding: 'utf8' });
  const out = res.stdout + res.stderr;
  assert.equal(res.status, 1);
  assert.match(out, /error: P1/);
  assert.match(out, /P2 remove-skill/);
  assert.equal(fs.existsSync(skill), false);
  assert.match(out, /undo:/);
});

test('cli: --undo exits 1 and reports failed entries when a stored copy is missing', () => {
  const r = fx();
  const plan = writePlan(r, [{ id: 'P1', action: 'disable-plugin', target: 'alpha', harness: 'claude', reason: 'x', manual: false }]);
  const out = execFileSync('node', [APPLY, '--plan', plan, '--ids', 'P1', '--yes', ...rootFlags(r)], { encoding: 'utf8' });
  const stamp = /--undo (\S+)/.exec(out)[1];
  const manifest = readJson(path.join(r.out, 'backups', stamp, 'manifest.json'));
  fs.rmSync(manifest.entries[0].stored);
  const res = spawnSync('node', [APPLY, '--undo', stamp, ...rootFlags(r)], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.match(res.stdout + res.stderr, /failed/);
});

test('cli: manual-only selection exits 2 with instruction; --dry-run changes nothing', () => {
  const r = fx();
  const plan = writePlan(r, [
    { id: 'P3', action: 'edit-instructions', path: path.join(r.claudeRoot, 'CLAUDE.md'), harness: 'claude', reason: 'fix model name', manual: true },
    { id: 'P1', action: 'disable-plugin', target: 'alpha', harness: 'claude', reason: 'x', manual: false },
  ]);
  const res = spawnSync('node', [APPLY, '--plan', plan, '--ids', 'P3', '--yes', ...rootFlags(r)], { encoding: 'utf8' });
  assert.equal(res.status, 2);
  assert.match(res.stdout + res.stderr, /manual/);
  const dry = execFileSync('node', [APPLY, '--plan', plan, '--ids', 'P1', '--yes', '--dry-run', ...rootFlags(r)], { encoding: 'utf8' });
  assert.match(dry, /dry-run/);
  assert.equal(readJson(path.join(r.claudeRoot, 'settings.json')).enabledPlugins['alpha@mk'], true);
  assert.equal(fs.existsSync(path.join(r.out, 'backups')), false);
});
