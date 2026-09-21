import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToml, removeTable, listTables } from '../scripts/lib/toml.mjs';

const SAMPLE = `# top comment
model = "gpt-6-astra"
model_reasoning_effort = "high"
notify = ["a", "b"]
count = 3

[projects."/Users/x/dead"]
trust_level = "trusted"

[mcp_servers.pal]
command = "uvx"
args = ["pal-mcp"]
enabled = true

[mcp_servers.pal.env]
KEY = "v"

[mcp_servers.ctx]
url = "https://example"
`;

test('parseToml reads top-level values', () => {
  const t = parseToml(SAMPLE);
  assert.equal(t.model, 'gpt-6-astra');
  assert.equal(t.model_reasoning_effort, 'high');
  assert.deepEqual(t.notify, ['a', 'b']);
  assert.equal(t.count, 3);
});

test('parseToml nests dotted and quoted table headers', () => {
  const t = parseToml(SAMPLE);
  assert.equal(t.projects['/Users/x/dead'].trust_level, 'trusted');
  assert.equal(t.mcp_servers.pal.command, 'uvx');
  assert.deepEqual(t.mcp_servers.pal.args, ['pal-mcp']);
  assert.equal(t.mcp_servers.pal.enabled, true);
  assert.equal(t.mcp_servers.pal.env.KEY, 'v');
  assert.equal(t.mcp_servers.ctx.url, 'https://example');
});

test('parseToml records a warning with line number and keeps parsing', () => {
  const warnings = [];
  const t = parseToml('x = { a = 1 }\nmodel = "m"\n', warnings);
  assert.equal(t.model, 'm');
  assert.equal(warnings[0].line, 1);
});

test('listTables returns paths with line numbers', () => {
  const tables = listTables(SAMPLE);
  assert.deepEqual(tables.map(t => t.path), [
    ['projects', '/Users/x/dead'], ['mcp_servers', 'pal'], ['mcp_servers', 'pal', 'env'], ['mcp_servers', 'ctx'],
  ]);
  assert.equal(tables[0].line, 7);
});

test('listTables recognises [[array]] headers', () => {
  const tables = listTables('[[servers]]\nname = "a"\n\n[mcp_servers.pal]\ncommand = "uvx"\n');
  assert.deepEqual(tables.map(t => t.path), [['servers'], ['mcp_servers', 'pal']]);
  assert.equal(tables[0].array, true);
});

test('parseToml skips [[array]] sections entirely with a warning', () => {
  const warnings = [];
  const t = parseToml('[[servers]]\nname = "a"\n\n[other]\nkey = "m"\n', warnings);
  assert.equal(t.other.key, 'm');
  assert.equal(t.servers, undefined);
  assert.ok(warnings.some(w => w.text === 'array of tables skipped'));
});

test('removeTable never swallows an [[array]] section that follows the removed table', () => {
  const text = '[mcp_servers.pal]\ncommand = "uvx"\n\n[[servers]]\nname = "a"\n';
  const out = removeTable(text, ['mcp_servers', 'pal']);
  assert.doesNotMatch(out, /mcp_servers\.pal/);
  assert.match(out, /\[\[servers\]\]\nname = "a"/);
});

test('removeTable keeps the trailing newline when the removed table is last', () => {
  const out = removeTable('model = "x"\n[a.b]\nk = 1\n', ['a', 'b']);
  assert.equal(out, 'model = "x"\n');
});

test('removeTable drops the table and its sub-tables, keeps everything else', () => {
  const out = removeTable(SAMPLE, ['mcp_servers', 'pal']);
  assert.doesNotMatch(out, /\[mcp_servers\.pal\]/);
  assert.doesNotMatch(out, /\[mcp_servers\.pal\.env\]/);
  assert.doesNotMatch(out, /command = "uvx"/);
  assert.match(out, /\[mcp_servers\.ctx\]\nurl = "https:\/\/example"/);
  assert.match(out, /# top comment\nmodel = "gpt-6-astra"/);
  assert.match(out, /\[projects\."\/Users\/x\/dead"\]\ntrust_level = "trusted"/);
});

test('removeTable with quoted key path', () => {
  const out = removeTable(SAMPLE, ['projects', '/Users/x/dead']);
  assert.doesNotMatch(out, /dead/);
  assert.match(out, /\[mcp_servers\.pal\]/);
});

test('removeTable returns input unchanged when absent', () => {
  assert.equal(removeTable(SAMPLE, ['nope']), SAMPLE);
});
