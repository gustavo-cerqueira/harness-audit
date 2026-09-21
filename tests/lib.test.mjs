import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFrontmatter } from '../scripts/lib/frontmatter.mjs';
import { filesNewerThan, scanJsonl } from '../scripts/lib/jsonl.mjs';
import { parseArgs, resolveRoots } from '../scripts/lib/args.mjs';

test('readFrontmatter single-line', () => {
  const fm = readFrontmatter('---\nname: grilling\ndescription: Grill the user. Use when X.\n---\n# body');
  assert.equal(fm.name, 'grilling');
  assert.equal(fm.description, 'Grill the user. Use when X.');
});

test('readFrontmatter folded block scalar', () => {
  const fm = readFrontmatter('---\nname: a\ndescription: >\n  line one\n  line two\nother: x\n---\n');
  assert.equal(fm.description, 'line one line two');
  assert.equal(fm.raw.other, 'x');
});

test('readFrontmatter missing block', () => {
  assert.deepEqual(readFrontmatter('# no frontmatter'), { name: null, description: '', raw: {} });
});

test('filesNewerThan filters by mtime and extension, missing dir is empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  const oldF = path.join(dir, 'sub', 'old.jsonl');
  const newF = path.join(dir, 'new.jsonl');
  fs.writeFileSync(oldF, '');
  fs.writeFileSync(newF, '');
  fs.writeFileSync(path.join(dir, 'skip.txt'), '');
  const old = new Date(Date.now() - 40 * 86400e3);
  fs.utimesSync(oldF, old, old);
  const since = Date.now() - 30 * 86400e3;
  assert.deepEqual(filesNewerThan(dir, since, '.jsonl'), [newF]);
  assert.deepEqual(filesNewerThan(path.join(dir, 'nope'), since, '.jsonl'), []);
});

test('filesNewerThan skips a dangling symlink entry without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-'));
  fs.symlinkSync(path.join(dir, 'nonexistent-target'), path.join(dir, 'dangling.jsonl'));
  const since = Date.now() - 30 * 86400e3;
  assert.doesNotThrow(() => filesNewerThan(dir, since, '.jsonl'));
  assert.deepEqual(filesNewerThan(dir, since, '.jsonl'), []);
});

test('scanJsonl streams matching lines and skips malformed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-'));
  const f = path.join(dir, 'a.jsonl');
  fs.writeFileSync(f, '{"a":1,"k":"tool_use"}\nnot json tool_use\n{"a":2}\n{"a":3,"k":"tool_use"}\n');
  const seen = [];
  await scanJsonl(f, 'tool_use', o => seen.push(o.a));
  assert.deepEqual(seen, [1, 3]);
});

test('parseArgs handles values and flags', () => {
  assert.deepEqual(parseArgs(['--out', '/tmp/x', '--json', '--days', '7', '--ids', 'P1,P2']),
    { out: '/tmp/x', json: true, days: '7', ids: 'P1,P2' });
  assert.deepEqual(parseArgs(['--claude-root', '/c']), { claudeRoot: '/c' });
});

test('resolveRoots defaults from HOME and honors overrides', () => {
  const r = resolveRoots({}, { HOME: '/h' });
  assert.equal(r.claudeRoot, '/h/.claude');
  assert.equal(r.codexRoot, '/h/.codex');
  assert.equal(r.claudeJson, '/h/.claude.json');
  assert.equal(r.out, '/h/.harness-audit');
  assert.equal(r.days, 30);
  const o = resolveRoots({ home: '/z', codexRoot: '/k', days: '7' }, { HOME: '/h' });
  assert.equal(o.claudeRoot, '/z/.claude');
  assert.equal(o.codexRoot, '/k');
  assert.equal(o.days, 7);
});

test('resolveRoots falls back to os.homedir() when HOME is unset', () => {
  const r = resolveRoots({}, {});
  assert.equal(r.home, os.homedir());
});

test('resolveRoots rejects a non-integer --days, accepts a positive integer', () => {
  assert.throws(() => resolveRoots({ days: 'abc' }, { HOME: '/h' }), /--days must be a positive integer/);
  assert.throws(() => resolveRoots({ days: '0' }, { HOME: '/h' }), /--days must be a positive integer/);
  assert.equal(resolveRoots({ days: '7' }, { HOME: '/h' }).days, 7);
});
