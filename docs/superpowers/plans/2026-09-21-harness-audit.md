> Historical implementation plan (2026-09-21). The [revised design](../specs/2026-09-21-harness-audit-design.md) and current SKILL.md supersede the original usage, removal and recovery assumptions below.

# harness-audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A skill plus two Node scripts that inventory a Claude Code and Codex CLI harness, report overlap, dead weight, conflicts, startup cost and clutter, and apply approved removals with backup and undo.

**Architecture:** `scripts/audit.mjs` produces `inventory.json` from config files and transcripts (deterministic, tested). `SKILL.md` tells the model how to turn the inventory into `report.md` and `plan.json` (judgement). `scripts/apply.mjs` executes plan ids after confirmation, backing up every touched path and offering `--undo`.

**Tech Stack:** Node.js 18+, ESM (`.mjs`), stdlib only (`node:fs`, `node:path`, `node:readline`, `node:os`, `node:test`, `node:assert`). No `package.json` dependencies.

**Spec:** `docs/superpowers/specs/2026-09-21-harness-audit-design.md`

## Global Constraints

- Node.js 18 or newer. No npm dependencies. Every import is `node:*` or a local file.
- All code, comments, docs and README in English.
- Scripts never write outside `--out` (default `~/.harness-audit`) except `apply.mjs` acting on approved plan items, and then only after the backup exists.
- No network calls anywhere.
- Every root path (`--claude-root`, `--codex-root`, `--claude-json`, `--out`, `--home`) is overridable so tests never touch the real home.
- The skill's own directory (`harness-audit`) is excluded from every inventory list.
- Tokens estimate: `Math.ceil(chars / 4)`, always labeled "estimate".
- Skill ids: user skills bare (`grilling`), plugin skills `plugin:name` (`superpowers:brainstorming`). Plugin name is the part before `@` in `enabledPlugins` keys.
- Exit codes for `apply.mjs`: 0 ok, 1 error, 2 refused.
- Commit after every task with message prefix `feat:`, `test:` or `docs:`, ending with the attribution line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## File Structure

```
package.json                     { "type": "module", "scripts": { "test": "node --test tests/" } }
SKILL.md                         skill instructions (report + apply modes)
README.md
scripts/audit.mjs                CLI entry: args -> collect -> analyze -> write inventory.json -> print summary
scripts/apply.mjs                CLI entry: plan + ids -> backup -> actions -> print undo command
scripts/lib/args.mjs             parseArgs(argv), resolveRoots(args)
scripts/lib/toml.mjs             parseToml(text), removeTable(text, tablePath)
scripts/lib/frontmatter.mjs      readFrontmatter(text) -> { name, description }
scripts/lib/jsonl.mjs            filesNewerThan(dir, sinceMs, ext), scanJsonl(file, needle, onObject)
scripts/lib/claude.mjs           collectClaude(roots) -> inventory.claude
scripts/lib/codex.mjs            collectCodex(roots) -> inventory.codex
scripts/lib/usage.mjs            usageClaude(projectsDir, sinceMs), usageCodex(sessionsDir, sinceMs)
scripts/lib/analysis.mjs         startupCost(inv), extractFacts(inv)
scripts/lib/backup.mjs           createBackup(outDir, paths), restoreBackup(outDir, stamp, force)
scripts/lib/actions.mjs          one exported function per plan action
tests/helpers/fixture.mjs        buildFixture(tmpDir) -> roots (fresh timestamps every run)
tests/toml.test.mjs
tests/lib.test.mjs               frontmatter, jsonl, args
tests/audit.test.mjs
tests/apply.test.mjs
```

Verified layout facts (from a real install, 2026-09-21):

- `~/.claude/plugins/installed_plugins.json` has `{ "version": 2, "plugins": { "<name>@<marketplace>": [ { "scope": "user", "installPath": "<abs dir>", "version": "...", "installedAt": "...", "lastUpdated": "..." } ] } }`. Use `installPath` as the plugin directory. Do not guess cache paths.
- A plugin dir contains `.claude-plugin/plugin.json` (`name`, `description`, `version`), optional `skills/<name>/SKILL.md`, `agents/<name>.md`, `hooks/hooks.json`, `.mcp.json` (`{ "mcpServers": { ... } }`).
- Old plugin versions in the cache carry a `.orphaned_at` file. Report them as clutter kind `orphaned-plugin-version`.
- `~/.claude/settings.json` `enabledPlugins` is `{ "<name>@<marketplace>": true|false }`.
- `~/.claude/settings.json` `hooks` is `{ "<Event>": [ { "matcher": "...", "hooks": [ { "type": "command", "command": "..." } ] } ] }`.
- `~/.claude.json` has top-level `mcpServers` and `projects.<path>.mcpServers`.
- Skill and agent files start with YAML frontmatter delimited by `---`; keys `name:` and `description:`; description is one line, sometimes long.
- Claude Code transcript lines: `{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"superpowers:brainstorming"}}]},"timestamp":"2026-09-21T13:35:42.267Z"}`. MCP tools are named `mcp__<server>__<tool>`; plugin MCP servers appear as `mcp__plugin_<plugin>_<server>__<tool>`.
- Codex rollout lines: `{"timestamp":"...","type":"response_item","payload":{"type":"function_call","name":"...","arguments":"..."}}`. Session meta line has `payload.cwd`.
- `~/.codex/config.toml` top-level `model = "..."`, `model_reasoning_effort = "..."`, tables `[mcp_servers.<name>]` with `command`/`args` or `url`, `[projects."<abs path>"]` with `trust_level`.
- `~/.codex/hooks.json` is `{ "hooks": { "<Event>": [ ... ] } }` in the same shape as Claude's.

---

### Task 1: Scaffold and TOML subset parser

**Files:**
- Create: `package.json`, `scripts/lib/toml.mjs`, `tests/toml.test.mjs`

**Interfaces:**
- Produces: `parseToml(text: string): object` — nested plain object. Table headers `[a.b]` and `[a."quoted key"]` create nested objects. Values: `"string"`, `'string'`, integers, floats, `true`/`false`, single-line arrays of those. Comments (`#`) and blank lines ignored. Unknown syntax throws `Error("toml: unsupported line N: <text>")`.
- Produces: `removeTable(text: string, tablePath: string[]): string` — removes the header line whose path equals `tablePath` and every line up to (not including) the next header whose path is not a child of `tablePath`. All other bytes preserved. Returns the input unchanged when the table is absent.
- Produces: `listTables(text: string): { path: string[], line: number }[]` — every header with its 1-based line.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "harness-audit",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=18" },
  "scripts": { "test": "node --test tests/" }
}
```

- [ ] **Step 2: Write the failing tests**

```js
// tests/toml.test.mjs
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

test('parseToml throws on unsupported syntax with line number', () => {
  assert.throws(() => parseToml('x = { a = 1 }\n'), /toml: unsupported line 1/);
});

test('listTables returns paths with line numbers', () => {
  const tables = listTables(SAMPLE);
  assert.deepEqual(tables.map(t => t.path), [
    ['projects', '/Users/x/dead'], ['mcp_servers', 'pal'], ['mcp_servers', 'pal', 'env'], ['mcp_servers', 'ctx'],
  ]);
  assert.equal(tables[0].line, 7);
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/toml.test.mjs`
Expected: FAIL, `Cannot find module '.../scripts/lib/toml.mjs'`

- [ ] **Step 4: Implement `scripts/lib/toml.mjs`**

```js
// scripts/lib/toml.mjs
// ponytail: line-based TOML subset (bare/dotted/quoted tables, scalars, flat arrays).
// Enough for ~/.codex/config.toml. Inline tables and multi-line arrays throw.

const HEADER = /^\s*\[([^\]]+)\]\s*(#.*)?$/;
const KV = /^\s*([A-Za-z0-9_.-]+|"[^"]*")\s*=\s*(.+?)\s*$/;

function splitHeaderPath(inner) {
  const parts = [];
  let cur = '', q = false;
  for (const ch of inner) {
    if (ch === '"') { q = !q; continue; }
    if (ch === '.' && !q) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}

function parseValue(raw, lineNo) {
  const s = raw.replace(/\s+#.*$/, '').trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(s)) return JSON.parse(s);
  if (/^'[^']*'$/.test(s)) return s.slice(1, -1);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    const items = [];
    let cur = '', q = false;
    for (const ch of inner) {
      if (ch === '"') q = !q;
      if (ch === ',' && !q) { items.push(cur); cur = ''; continue; }
      cur += ch;
    }
    items.push(cur);
    return items.map(i => i.trim()).filter(Boolean).map(i => parseValue(i, lineNo));
  }
  throw new Error(`toml: unsupported line ${lineNo}: ${raw}`);
}

export function listTables(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    const m = HEADER.exec(line);
    if (m) out.push({ path: splitHeaderPath(m[1]), line: i + 1 });
  });
  return out;
}

export function parseToml(text) {
  const root = {};
  let cur = root;
  text.split('\n').forEach((line, i) => {
    const n = i + 1;
    const t = line.trim();
    if (t === '' || t.startsWith('#')) return;
    const h = HEADER.exec(line);
    if (h) {
      cur = root;
      for (const p of splitHeaderPath(h[1])) cur = (cur[p] ??= {});
      return;
    }
    const kv = KV.exec(line);
    if (!kv) throw new Error(`toml: unsupported line ${n}: ${line}`);
    const key = kv[1].startsWith('"') ? kv[1].slice(1, -1) : kv[1];
    cur[key] = parseValue(kv[2], n);
  });
  return root;
}

function isChild(path, parent) {
  return path.length >= parent.length && parent.every((p, i) => p === path[i]);
}

export function removeTable(text, tablePath) {
  const lines = text.split('\n');
  const tables = listTables(text);
  const start = tables.find(t => t.path.length === tablePath.length && isChild(t.path, tablePath));
  if (!start) return text;
  const next = tables.find(t => t.line > start.line && !isChild(t.path, tablePath));
  const from = start.line - 1;
  const to = next ? next.line - 1 : lines.length;
  return [...lines.slice(0, from), ...lines.slice(to)].join('\n');
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/toml.test.mjs`
Expected: 7 pass, 0 fail

- [ ] **Step 6: Commit**

```bash
git add package.json scripts/lib/toml.mjs tests/toml.test.mjs
git commit -m "feat: toml subset parser with table removal

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: frontmatter, jsonl streaming, args

**Files:**
- Create: `scripts/lib/frontmatter.mjs`, `scripts/lib/jsonl.mjs`, `scripts/lib/args.mjs`, `tests/lib.test.mjs`

**Interfaces:**
- Produces: `readFrontmatter(text: string): { name: string|null, description: string, raw: object }` — parses the `---` block; `description` supports single-line and `>`/`|` block scalars (joined with spaces); missing block returns `{ name: null, description: '', raw: {} }`.
- Produces: `filesNewerThan(dir: string, sinceMs: number, ext: string): string[]` — recursive, returns absolute paths of files with the extension and `mtimeMs >= sinceMs`; missing dir returns `[]`.
- Produces: `scanJsonl(file: string, needle: string, onObject: (obj) => void): Promise<void>` — streams lines with `readline`; skips lines not containing `needle`; skips lines that fail `JSON.parse`.
- Produces: `parseArgs(argv: string[]): object` — `--key value` and `--flag` (boolean) into an object with camelCase keys; `--ids a,b` stays a string.
- Produces: `resolveRoots(args: object, env = process.env): { home, claudeRoot, codexRoot, claudeJson, out, days, cwd }` — defaults `home = env.HOME`, `claudeRoot = home/.claude`, `codexRoot = home/.codex`, `claudeJson = home/.claude.json`, `out = home/.harness-audit`, `days = 30`, `cwd = process.cwd()`. `--home` overrides the base for all defaults; individual flags override individually.

- [ ] **Step 1: Write the failing tests**

```js
// tests/lib.test.mjs
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/lib.test.mjs`
Expected: FAIL, cannot find module

- [ ] **Step 3: Implement the three modules**

```js
// scripts/lib/frontmatter.mjs
export function readFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return { name: null, description: '', raw: {} };
  const raw = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let val = kv[2].trim();
    if (val === '>' || val === '|' || val === '>-' || val === '|-') {
      const block = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      val = block.join(' ');
    }
    raw[kv[1]] = val.replace(/^["']|["']$/g, '');
  }
  return { name: raw.name ?? null, description: raw.description ?? '', raw };
}
```

```js
// scripts/lib/jsonl.mjs
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export function filesNewerThan(dir, sinceMs, ext) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && p.endsWith(ext) && fs.statSync(p).mtimeMs >= sinceMs) out.push(p);
    }
  };
  walk(dir);
  return out;
}

export async function scanJsonl(file, needle, onObject) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes(needle)) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    onObject(obj);
  }
}
```

```js
// scripts/lib/args.mjs
import path from 'node:path';

const camel = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = camel(a.slice(2));
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

export function resolveRoots(args, env = process.env) {
  const home = args.home ?? env.HOME ?? '';
  return {
    home,
    claudeRoot: args.claudeRoot ?? path.join(home, '.claude'),
    codexRoot: args.codexRoot ?? path.join(home, '.codex'),
    claudeJson: args.claudeJson ?? path.join(home, '.claude.json'),
    out: args.out ?? path.join(home, '.harness-audit'),
    days: Number(args.days ?? 30),
    cwd: args.cwd ?? process.cwd(),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/lib.test.mjs`
Expected: 7 pass

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/frontmatter.mjs scripts/lib/jsonl.mjs scripts/lib/args.mjs tests/lib.test.mjs
git commit -m "feat: frontmatter, jsonl streaming and args helpers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Fixture builder and Claude Code inventory

**Files:**
- Create: `tests/helpers/fixture.mjs`, `scripts/lib/claude.mjs`, `tests/audit.test.mjs` (first tests; later tasks append)

**Interfaces:**
- Produces: `buildFixture(tmpDir: string): { home, claudeRoot, codexRoot, claudeJson, out, days, cwd }` — writes a complete fake home under `tmpDir/home` with fresh timestamps and returns roots in the same shape as `resolveRoots`.
- Produces: `collectClaude(roots): { root, plugins, skills, agents, hooks, mcpServers, instructionFiles, clutter, warnings }` (shape per spec). Returns `null` when `roots.claudeRoot` does not exist.
- Item shapes:
  - plugin: `{ name, marketplace, enabled, path, version, skills, agents, hooks, mcpServers }` (counts)
  - skill: `{ id, name, description, source, path, descriptionChars, loaded }` — `loaded` is false for skills of disabled plugins
  - agent: `{ id, description, source, path, loaded }`
  - hooks: `{ [event]: [ { command, matcher, source } ] }` — `source` is `settings.json`, `settings.local.json`, `project:.claude/settings.json` or `plugin:<name>`; disabled plugin hooks are not included
  - mcpServer: `{ name, source, transport, command, enabled }` — `transport` is `http` when `url`/`type: http`, else `stdio`; source `~/.claude.json`, `~/.claude.json#project:<path>`, `settings.json`, `project:.mcp.json`, `plugin:<name>`
  - instructionFile: `{ path, words, tokensEst }`
  - clutter: `{ path, kind, bytes }` with kinds `backup`, `temp-clone`, `orphaned-plugin-version`, `stale-project-dir`
- Helper exported for reuse: `dirBytes(p: string): number` (recursive size, 0 if missing).

- [ ] **Step 1: Write the fixture builder**

```js
// tests/helpers/fixture.mjs
import fs from 'node:fs';
import path from 'node:path';

const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const skill = (dir, name, desc) => w(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n`);
const agent = (file, name, desc) => w(file, `---\nname: ${name}\ndescription: ${desc}\ntools: Read\n---\nbody\n`);
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400e3).toISOString();
const touch = (p, daysAgo) => { const d = new Date(Date.now() - daysAgo * 86400e3); fs.utimesSync(p, d, d); };

export function buildFixture(tmpDir) {
  const home = path.join(tmpDir, 'home');
  const claudeRoot = path.join(home, '.claude');
  const codexRoot = path.join(home, '.codex');
  const claudeJson = path.join(home, '.claude.json');
  const cwd = path.join(tmpDir, 'proj');
  fs.mkdirSync(cwd, { recursive: true });

  // --- Claude Code ---
  const cache = path.join(claudeRoot, 'plugins', 'cache', 'mk');
  const alpha = path.join(cache, 'alpha', 'v1');
  const beta = path.join(cache, 'beta', 'v1');
  w(path.join(alpha, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'alpha', description: 'Alpha plugin', version: '1.0.0' }));
  skill(path.join(alpha, 'skills'), 'brainstorming', 'Explore requirements before building. Use before any creative work.');
  skill(path.join(alpha, 'skills'), 'debugging', 'Find root cause of bugs. Use on any bug or test failure.');
  skill(path.join(alpha, 'skills'), 'review', 'Review a diff for bugs.');
  agent(path.join(alpha, 'agents', 'explorer.md'), 'explorer', 'Read-only explorer.');
  w(path.join(alpha, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo alpha-start' }] }] } }));
  w(path.join(alpha, '.mcp.json'), JSON.stringify({ mcpServers: { ctx: { type: 'http', url: 'https://ctx.example/mcp' } } }));
  w(path.join(beta, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'beta', description: 'Beta plugin', version: '1.0.0' }));
  skill(path.join(beta, 'skills'), 'one', 'Beta skill one.');
  w(path.join(cache, 'alpha', 'v0', '.orphaned_at'), iso(10));
  w(path.join(cache, 'alpha', 'v0', 'README.md'), 'old');
  w(path.join(claudeRoot, 'plugins', 'cache', 'temp_git_123', 'x.txt'), 'tmp');
  w(path.join(claudeRoot, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      'alpha@mk': [{ scope: 'user', installPath: alpha, version: 'v1', installedAt: iso(20), lastUpdated: iso(1) }],
      'beta@mk': [{ scope: 'user', installPath: beta, version: 'v1', installedAt: iso(20), lastUpdated: iso(1) }],
    },
  }));
  w(path.join(claudeRoot, 'settings.json'), JSON.stringify({
    enabledPlugins: { 'alpha@mk': true, 'beta@mk': false },
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard1.js' }, { type: 'command', command: 'node guard2.js' }] },
        { matcher: 'Write', hooks: [{ type: 'command', command: 'node guard3.js' }] },
      ],
      PostToolUse: [{ hooks: [{ type: 'command', command: 'bash post.sh' }] }],
    },
    mcpServers: { local: { command: 'node', args: ['srv.js'] } },
  }));
  w(path.join(claudeRoot, 'settings.json.bak-1'), '{}');
  w(claudeJson, JSON.stringify({
    mcpServers: { pal: { command: 'uvx', args: ['pal-mcp'] } },
    projects: { [cwd]: { mcpServers: { projsrv: { type: 'http', url: 'https://p.example' } } } },
  }));
  skill(path.join(claudeRoot, 'skills'), 'grilling', 'Grill the user about a plan.');
  skill(path.join(claudeRoot, 'skills'), 'grill-me', 'Grill me relentlessly about an idea.');
  skill(path.join(claudeRoot, 'skills'), 'harness-audit', 'Audit the harness. Must be excluded.');
  agent(path.join(claudeRoot, 'agents', 'gsd-planner.md'), 'gsd-planner', 'Creates phase plans.');
  w(path.join(claudeRoot, 'CLAUDE.md'), [
    '# Global rules', '',
    'Codex config sets `model = "gpt-5.6-terra"` and `model_reasoning_effort = "medium"`.',
    'Use the pal MCP server for second opinions and the ghost MCP server for nothing.',
    'The beta plugin handles formatting.', '',
    ...Array.from({ length: 40 }, (_, i) => `Rule ${i}: keep things lean and measured.`),
  ].join('\n'));
  w(path.join(cwd, 'CLAUDE.md'), '# Project rules\nRun tests before commit.\n');

  // transcripts: one recent, one old (outside window), one stale project dir
  const projSlug = cwd.replace(/\//g, '-');
  const tu = (name, input) => JSON.stringify({ type: 'assistant', cwd, timestamp: iso(2), message: { content: [{ type: 'tool_use', id: 't', name, input }] } });
  const recent = path.join(claudeRoot, 'projects', projSlug, 's1.jsonl');
  w(recent, [
    JSON.stringify({ type: 'user', cwd, timestamp: iso(2), message: { content: 'hi' } }),
    tu('Skill', { skill: 'alpha:brainstorming' }),
    tu('Skill', { skill: 'alpha:brainstorming' }),
    tu('Skill', { skill: 'grilling' }),
    tu('mcp__pal__chat', { prompt: 'x' }),
    tu('mcp__plugin_alpha_ctx__query', { q: 'x' }),
    tu('Agent', { subagent_type: 'Explore', prompt: 'x' }),
    tu('Bash', { command: 'ls' }),
  ].join('\n') + '\n');
  const old = path.join(claudeRoot, 'projects', projSlug, 's0.jsonl');
  w(old, [tu('Skill', { skill: 'grill-me' }), tu('Skill', { skill: 'grill-me' })].join('\n') + '\n');
  touch(old, 45);
  const stale = path.join(claudeRoot, 'projects', '-nope-gone', 's9.jsonl');
  w(stale, JSON.stringify({ type: 'user', cwd: '/nope/gone', timestamp: iso(2), message: { content: 'hi' } }) + '\n');

  // --- Codex ---
  w(path.join(codexRoot, 'config.toml'), [
    'model = "gpt-6-astra"',
    'model_reasoning_effort = "high"',
    '',
    `[projects."${cwd}"]`,
    'trust_level = "trusted"',
    '',
    '[projects."/nope/dead"]',
    'trust_level = "trusted"',
    '',
    '[mcp_servers.basic-memory]',
    'command = "uvx"',
    'args = ["basic-memory", "mcp"]',
    '',
    '[mcp_servers.pal]',
    'command = "uvx"',
    'args = ["pal-mcp"]',
    '',
    '[mcp_servers.pal.env]',
    'KEY = "v"',
    '',
  ].join('\n'));
  w(path.join(codexRoot, 'config.toml.bak-1'), 'model = "old"\n');
  skill(path.join(codexRoot, 'skills'), 'web-fetch-router', 'Pick the cheapest web fetch tool.');
  skill(path.join(codexRoot, 'skills'), 'harness-audit', 'Audit the harness. Must be excluded.');
  w(path.join(codexRoot, 'AGENTS.md'), '# Codex rules\nAlways run tests.\n');
  w(path.join(cwd, 'AGENTS.md'), '# Project codex rules\n');
  w(path.join(codexRoot, 'hooks.json'), JSON.stringify({ hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }, { type: 'command', command: 'c' }] }],
  } }));
  const roll = path.join(codexRoot, 'sessions', '2026', '09', '20', 'rollout-1.jsonl');
  const fc = (name) => JSON.stringify({ timestamp: iso(3), type: 'response_item', payload: { type: 'function_call', name, arguments: '{}' } });
  w(roll, [
    JSON.stringify({ timestamp: iso(3), type: 'session_meta', payload: { cwd, cli_version: '0.154.0' } }),
    fc('mcp__pal__chat'),
    fc('pal__chat'),
    fc('shell'),
    JSON.stringify({ timestamp: iso(3), type: 'response_item', payload: { type: 'function_call_output', output: `read ${codexRoot}/skills/web-fetch-router/SKILL.md ok` } }),
  ].join('\n') + '\n');

  const out = path.join(tmpDir, 'out');
  return { home, claudeRoot, codexRoot, claudeJson, out, days: 30, cwd };
}
```

- [ ] **Step 2: Write the failing tests for `collectClaude`**

```js
// tests/audit.test.mjs
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
  const alpha = c.plugins.find(p => p.name === 'alpha');
  const beta = c.plugins.find(p => p.name === 'beta');
  assert.equal(alpha.enabled, true);
  assert.equal(alpha.marketplace, 'mk');
  assert.deepEqual([alpha.skills, alpha.agents, alpha.hooks, alpha.mcpServers], [3, 1, 1, 1]);
  assert.equal(beta.enabled, false);
});

test('collectClaude: skills from user dir and plugins, audit skill excluded, disabled plugin skills not loaded', () => {
  const c = collectClaude(fx());
  assert.deepEqual(ids(c.skills), ['alpha:brainstorming', 'alpha:debugging', 'alpha:review', 'beta:one', 'grill-me', 'grilling']);
  assert.equal(c.skills.find(s => s.id === 'grilling').source, 'user');
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test tests/audit.test.mjs`
Expected: FAIL, cannot find module `claude.mjs`

- [ ] **Step 4: Implement `scripts/lib/claude.mjs`**

```js
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
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== SELF && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
    .map(e => {
      const p = path.join(dir, e.name, 'SKILL.md');
      const fm = readFrontmatter(fs.readFileSync(p, 'utf8'));
      const name = fm.name ?? e.name;
      return { id: prefix ? `${prefix}:${name}` : name, name, description: fm.description, source, path: p, descriptionChars: fm.description.length, loaded };
    });
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
      const jsonl = fs.readdirSync(d).filter(f => f.endsWith('.jsonl')).map(f => path.join(d, f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
      if (!jsonl) continue;
      const first = fs.readFileSync(jsonl, 'utf8').split('\n').find(l => l.includes('"cwd"'));
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
    plugins.push({ name, marketplace, enabled, path: inst.installPath, version: inst.version ?? null, skills: pSkills.length, agents: pAgents.length, hooks: hookCount, mcpServers: Object.keys(pMcp).length });
    skills.push(...pSkills); agents.push(...pAgents);
    if (enabled) { flattenHooks(pHooks, src, hooks); mcpFrom(pMcp, src, mcpServers); }
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test tests/audit.test.mjs`
Expected: 8 pass

- [ ] **Step 6: Commit**

```bash
git add tests/helpers/fixture.mjs scripts/lib/claude.mjs tests/audit.test.mjs
git commit -m "feat: claude code inventory with fixture harness

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Codex inventory

**Files:**
- Create: `scripts/lib/codex.mjs`
- Modify: `tests/audit.test.mjs` (append)

**Interfaces:**
- Produces: `collectCodex(roots): { root, config: { model, effort, projects: [{ path, exists }] }, skills, agents, hooks, mcpServers, instructionFiles, clutter, warnings } | null`. Same item shapes as Task 3. Skill ids are bare. Skill `source` is `user` or `project` (from `roots.cwd/.codex/skills` if present). MCP source is `config.toml`. Hook source is `hooks.json`. Clutter kinds: `backup`, `dead-project-entry` (`{ path: '<config.toml>#projects.<p>', kind, bytes: 0 }`).
- Consumes: `parseToml` (Task 1), `readFrontmatter` (Task 2), `dirBytes` from `claude.mjs`.

- [ ] **Step 1: Append failing tests**

```js
// append to tests/audit.test.mjs
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/audit.test.mjs`
Expected: 4 new failures, cannot find module `codex.mjs`

- [ ] **Step 3: Implement `scripts/lib/codex.mjs`**

```js
// scripts/lib/codex.mjs
import fs from 'node:fs';
import path from 'node:path';
import { parseToml } from './toml.mjs';
import { readFrontmatter } from './frontmatter.mjs';
import { dirBytes, SELF } from './claude.mjs';

const tokens = s => Math.ceil(s.length / 4);

function skillsIn(dir, source) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name !== SELF && fs.existsSync(path.join(dir, e.name, 'SKILL.md')))
    .map(e => {
      const p = path.join(dir, e.name, 'SKILL.md');
      const fm = readFrontmatter(fs.readFileSync(p, 'utf8'));
      const name = fm.name ?? e.name;
      return { id: name, name, description: fm.description, source, path: p, descriptionChars: fm.description.length, loaded: true };
    });
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
    try { toml = parseToml(fs.readFileSync(configPath, 'utf8')); }
    catch (e) { warnings.push({ path: configPath, message: e.message }); }
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/audit.test.mjs`
Expected: 12 pass

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/codex.mjs tests/audit.test.mjs
git commit -m "feat: codex inventory

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Usage mining

**Files:**
- Create: `scripts/lib/usage.mjs`
- Modify: `tests/audit.test.mjs` (append)

**Interfaces:**
- Produces: `usageClaude(projectsDir: string, sinceMs: number): Promise<{ sessions, skills, agents, mcpTools, mcpServers, tools }>` — every map is `{ [name]: count }`. `sessions` is the number of transcript files scanned. `Skill` calls add to `skills[input.skill]`; `Agent` calls add to `agents[input.subagent_type]`; `mcp__X__Y` adds to `mcpTools['mcp__X__Y']` and `mcpServers[X]`; every tool_use adds to `tools[name]`. Plugin servers `mcp__plugin_<plugin>_<server>__tool` map to `mcpServers['<server>']` with the plugin prefix stripped (so `mcp__plugin_alpha_ctx__query` counts server `ctx`).
- Produces: `usageCodex(sessionsDir: string, sinceMs: number, knownServers: string[]): Promise<{ sessions, skills, mcpTools, mcpServers, tools }>` — `function_call` and `custom_tool_call` payloads count by `name`. Names `mcp__X__Y` count server `X`; names `X__Y` count server `X` when `X` is in `knownServers`. Any line containing `skills/<name>/SKILL.md` adds 1 to `skills[name]` once per file.
- Consumes: `filesNewerThan`, `scanJsonl` (Task 2).

- [ ] **Step 1: Append failing tests**

```js
// append to tests/audit.test.mjs
import { usageClaude, usageCodex } from '../scripts/lib/usage.mjs';

test('usageClaude counts skills, agents, mcp tools and servers inside the window only', async () => {
  const r = fx();
  const since = Date.now() - 30 * 86400e3;
  const u = await usageClaude(path.join(r.claudeRoot, 'projects'), since);
  assert.equal(u.sessions, 2); // s1 + stale project s9; s0 is 45 days old
  assert.deepEqual(u.skills, { 'alpha:brainstorming': 2, grilling: 1 });
  assert.deepEqual(u.agents, { Explore: 1 });
  assert.deepEqual(u.mcpTools, { mcp__pal__chat: 1, mcp__plugin_alpha_ctx__query: 1 });
  assert.deepEqual(u.mcpServers, { pal: 1, ctx: 1 });
  assert.equal(u.tools.Bash, 1);
});

test('usageCodex counts function calls, attributes servers, infers skills from SKILL.md paths', async () => {
  const r = fx();
  const since = Date.now() - 30 * 86400e3;
  const u = await usageCodex(path.join(r.codexRoot, 'sessions'), since, ['pal', 'basic-memory']);
  assert.equal(u.sessions, 1);
  assert.deepEqual(u.mcpServers, { pal: 2 });
  assert.deepEqual(u.mcpTools, { mcp__pal__chat: 1, pal__chat: 1 });
  assert.equal(u.tools.shell, 1);
  assert.deepEqual(u.skills, { 'web-fetch-router': 1 });
});

test('usage on missing dirs is empty', async () => {
  const u = await usageClaude('/nope/none', 0);
  assert.equal(u.sessions, 0);
  assert.deepEqual(u.skills, {});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/audit.test.mjs`
Expected: 3 new failures

- [ ] **Step 3: Implement `scripts/lib/usage.mjs`**

```js
// scripts/lib/usage.mjs
import { filesNewerThan, scanJsonl } from './jsonl.mjs';

const bump = (map, key) => { if (key) map[key] = (map[key] ?? 0) + 1; };

function serverOf(name, knownServers) {
  let m = /^mcp__plugin_[^_]+(?:_[^_]+)*?_([^_][^_]*?)__/.exec(name); // mcp__plugin_<plugin>_<server>__tool
  if (m) return m[1];
  m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name);
  if (m) return m[1];
  m = /^([^_]+(?:_[^_]+)*?)__/.exec(name);
  if (m && knownServers.includes(m[1])) return m[1];
  return null;
}

export async function usageClaude(projectsDir, sinceMs) {
  const u = { sessions: 0, skills: {}, agents: {}, mcpTools: {}, mcpServers: {}, tools: {} };
  for (const file of filesNewerThan(projectsDir, sinceMs, '.jsonl')) {
    u.sessions++;
    await scanJsonl(file, '"tool_use"', obj => {
      const content = obj?.message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block?.type !== 'tool_use') continue;
        bump(u.tools, block.name);
        if (block.name === 'Skill') bump(u.skills, block.input?.skill);
        else if (block.name === 'Agent') bump(u.agents, block.input?.subagent_type);
        else if (typeof block.name === 'string' && block.name.startsWith('mcp__')) {
          bump(u.mcpTools, block.name);
          bump(u.mcpServers, serverOf(block.name, []));
        }
      }
    });
  }
  return u;
}

export async function usageCodex(sessionsDir, sinceMs, knownServers = []) {
  const u = { sessions: 0, skills: {}, mcpTools: {}, mcpServers: {}, tools: {} };
  for (const file of filesNewerThan(sessionsDir, sinceMs, '.jsonl')) {
    u.sessions++;
    const skillsSeen = new Set();
    await scanJsonl(file, '', obj => {
      const raw = JSON.stringify(obj);
      for (const m of raw.matchAll(/skills\/([A-Za-z0-9_.-]+)\/SKILL\.md/g)) skillsSeen.add(m[1]);
      const p = obj?.payload;
      if (!p || (p.type !== 'function_call' && p.type !== 'custom_tool_call') || typeof p.name !== 'string') return;
      bump(u.tools, p.name);
      const server = serverOf(p.name, knownServers);
      if (server) { bump(u.mcpTools, p.name); bump(u.mcpServers, server); }
    });
    for (const s of skillsSeen) bump(u.skills, s);
  }
  return u;
}
```

Note on `serverOf`: server names may contain underscores (`basic_memory`), so the regexes take the shortest run up to the first `__`. The plugin form is `mcp__plugin_<plugin>_<server>__tool`; the plugin name never contains `_` in Claude Code's naming, so the first `_`-separated segment after `plugin_` is the plugin and the rest up to `__` is the server. If the test for `ctx` fails with this regex, simplify: strip `mcp__plugin_`, drop the first `_`-segment, take everything up to `__`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/audit.test.mjs`
Expected: 15 pass

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/usage.mjs tests/audit.test.mjs
git commit -m "feat: usage mining from claude and codex transcripts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Startup cost and facts

**Files:**
- Create: `scripts/lib/analysis.mjs`
- Modify: `tests/audit.test.mjs` (append)

**Interfaces:**
- Produces: `startupCost(claude, codex): { claude: { skillList, agentList, mcpToolNames, instructionFiles, hooks, total } | null, codex: {...} | null }` — `skillList = Σ ceil((id.length + min(description.length, 300) + 6) / 4)` over `loaded` skills; `agentList` same over loaded agents with full description; `mcpToolNames` is `null` (unknown without launching servers); `instructionFiles = Σ tokensEst`; `hooks` is the count of hook entries (not tokens); `total` = sum of the numeric token fields.
- Produces: `extractFacts(claude, codex): Fact[]` where `Fact = { key, config, mentions: [{ file, line, value }], conflict }`. Keys:
  - `codex.model`: config from `codex.config.model`; mentions are every `gpt-[a-z0-9.-]+`, `claude-[a-z0-9.-]+`, `o[1-9][a-z0-9-]*` token inside a `model = "..."` or `model:` context in any instruction file (Claude and Codex). Conflict when any mention differs from config.
  - `codex.effort`: config from `codex.config.effort`; mentions are `model_reasoning_effort = "X"` or `effort = "X"` in instruction files. Conflict when different.
  - `mcp.unknown-server`: config is the sorted list of configured server names across both harnesses; mentions are words matching `\b([a-z0-9-]+) (MCP|mcp) server\b` or `(MCP|mcp) server (named |called )?([a-z0-9-]+)` in instruction files whose name is not configured; conflict when mentions non-empty.
  - `plugin.disabled-but-mentioned`: config is enabled plugin names; mentions are `\b([a-z0-9-]+) plugin\b` matches whose name is an installed-but-disabled plugin; conflict when non-empty.
  Each fact is emitted only when its config source exists (skip `codex.*` when `codex` is null).

- [ ] **Step 1: Append failing tests**

```js
// append to tests/audit.test.mjs
import { startupCost, extractFacts } from '../scripts/lib/analysis.mjs';

test('startupCost counts loaded skills only and sums instruction files', () => {
  const r = fx();
  const c = collectClaude(r), k = collectCodex(r);
  const cost = startupCost(c, k);
  const loaded = c.skills.filter(s => s.loaded);
  const expectSkills = loaded.reduce((n, s) => n + Math.ceil((s.id.length + Math.min(s.description.length, 300) + 6) / 4), 0);
  assert.equal(cost.claude.skillList, expectSkills);
  assert.equal(cost.claude.mcpToolNames, null);
  assert.equal(cost.claude.instructionFiles, c.instructionFiles.reduce((n, f) => n + f.tokensEst, 0));
  assert.equal(cost.claude.hooks, 5);
  assert.equal(cost.claude.total, cost.claude.skillList + cost.claude.agentList + cost.claude.instructionFiles);
  assert.equal(cost.codex.hooks, 3);
  assert.equal(startupCost(null, k).claude, null);
});

test('extractFacts finds model/effort conflicts, unknown mcp server and disabled plugin mention', () => {
  const r = fx();
  const facts = extractFacts(collectClaude(r), collectCodex(r));
  const by = Object.fromEntries(facts.map(f => [f.key, f]));
  assert.equal(by['codex.model'].config, 'gpt-6-astra');
  assert.equal(by['codex.model'].conflict, true);
  assert.equal(by['codex.model'].mentions[0].value, 'gpt-5.6-terra');
  assert.equal(by['codex.model'].mentions[0].line, 3);
  assert.equal(by['codex.effort'].conflict, true);
  assert.equal(by['codex.effort'].mentions[0].value, 'medium');
  assert.deepEqual(by['mcp.unknown-server'].mentions.map(m => m.value), ['ghost']);
  assert.equal(by['mcp.unknown-server'].conflict, true);
  assert.deepEqual(by['plugin.disabled-but-mentioned'].mentions.map(m => m.value), ['beta']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/audit.test.mjs`
Expected: 2 new failures

- [ ] **Step 3: Implement `scripts/lib/analysis.mjs`**

```js
// scripts/lib/analysis.mjs
import fs from 'node:fs';

const t = n => Math.ceil(n / 4);
const hookCount = h => Object.values(h ?? {}).reduce((n, arr) => n + arr.length, 0);

function costFor(section) {
  if (!section) return null;
  const skillList = section.skills.filter(s => s.loaded).reduce((n, s) => n + t(s.id.length + Math.min(s.description.length, 300) + 6), 0);
  const agentList = section.agents.filter(a => a.loaded).reduce((n, a) => n + t(a.id.length + a.description.length + 6), 0);
  const instructionFiles = section.instructionFiles.reduce((n, f) => n + f.tokensEst, 0);
  return { skillList, agentList, mcpToolNames: null, instructionFiles, hooks: hookCount(section.hooks), total: skillList + agentList + instructionFiles };
}

export function startupCost(claude, codex) {
  return { claude: costFor(claude), codex: costFor(codex) };
}

function scanFiles(files, regex, pick) {
  const out = [];
  for (const f of files) {
    const lines = fs.readFileSync(f.path, 'utf8').split('\n');
    lines.forEach((line, i) => { for (const m of line.matchAll(regex)) { const value = pick(m); if (value) out.push({ file: f.path, line: i + 1, value }); } });
  }
  return out;
}

export function extractFacts(claude, codex) {
  const files = [...(claude?.instructionFiles ?? []), ...(codex?.instructionFiles ?? [])];
  const facts = [];
  if (codex) {
    const modelRe = /model\s*[=:]\s*["'`]?((?:gpt|claude|o[1-9])[a-z0-9.-]*)/gi;
    const mentions = scanFiles(files, modelRe, m => m[1]).filter(m => m.value !== codex.config.model);
    facts.push({ key: 'codex.model', config: codex.config.model, mentions, conflict: mentions.length > 0 });
    const effRe = /(?:model_reasoning_effort|reasoning_effort|effort)\s*[=:]\s*["'`]?([a-z]+)/gi;
    const eff = scanFiles(files, effRe, m => m[1]).filter(m => m.value !== codex.config.effort);
    facts.push({ key: 'codex.effort', config: codex.config.effort, mentions: eff, conflict: eff.length > 0 });
  }
  const servers = new Set([...(claude?.mcpServers ?? []), ...(codex?.mcpServers ?? [])].map(s => s.name));
  const srvRe = /\b([a-z0-9][a-z0-9-]*)\s+mcp\s+server\b|\bmcp\s+server\s+(?:named\s+|called\s+)?([a-z0-9][a-z0-9-]*)/gi;
  const unknown = scanFiles(files, srvRe, m => (m[1] ?? m[2]).toLowerCase()).filter(m => !servers.has(m.value) && !['the', 'a', 'an', 'this', 'that', 'each', 'every', 'any', 'no', 'one'].includes(m.value));
  facts.push({ key: 'mcp.unknown-server', config: [...servers].sort(), mentions: unknown, conflict: unknown.length > 0 });
  if (claude) {
    const disabled = new Set(claude.plugins.filter(p => !p.enabled).map(p => p.name));
    const plgRe = /\b([a-z0-9][a-z0-9-]*)\s+plugin\b/gi;
    const dm = scanFiles(files, plgRe, m => m[1].toLowerCase()).filter(m => disabled.has(m.value));
    facts.push({ key: 'plugin.disabled-but-mentioned', config: claude.plugins.filter(p => p.enabled).map(p => p.name).sort(), mentions: dm, conflict: dm.length > 0 });
  }
  return facts;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/audit.test.mjs`
Expected: 17 pass

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/analysis.mjs tests/audit.test.mjs
git commit -m "feat: startup cost estimate and config fact conflicts

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: `audit.mjs` entry point

**Files:**
- Create: `scripts/audit.mjs`
- Modify: `tests/audit.test.mjs` (append)

**Interfaces:**
- Produces: `runAudit(roots): Promise<inventory>` exported for tests; CLI `main()` runs when the file is the entry (`process.argv[1]` ends with `audit.mjs`).
- Inventory top level: `{ generatedAt, days, cwd, host: { platform, node, claudeCode, codexCli }, claude, codex, usage: { claude, codex }, startupCost, facts, warnings }`. `host.claudeCode` / `host.codexCli` come from `claude --version` / `codex --version` via `execFileSync` with a 3 s timeout, `null` on failure. `warnings` merges `claude.warnings` and `codex.warnings`.
- CLI flags: `--out`, `--days`, `--claude-root`, `--codex-root`, `--claude-json`, `--home`, `--cwd`, `--json`. Without `--json` writes `<out>/inventory.json` (mkdir -p) and prints a summary. With `--json` prints the inventory to stdout and writes nothing.
- Summary format (stdout, plain text):

```
harness-audit inventory written to <out>/inventory.json

Claude Code   skills 118 loaded (12 in disabled plugins)   agents 41   MCP servers 9   hooks 20   sessions(30d) 41
              startup cost estimate: 25,600 tokens (skills 18,200 · agents 4,100 · instructions 3,300 · MCP tool names: unknown)
Codex CLI     skills 6   MCP servers 8   hooks 16   sessions(30d) 12   model gpt-6-astra / high
              startup cost estimate: 2,700 tokens
Conflicts     2   Clutter   23 items, 4.1 MB   Warnings 0
```

- [ ] **Step 1: Append failing integration tests**

```js
// append to tests/audit.test.mjs
import { execFileSync } from 'node:child_process';
import { runAudit } from '../scripts/audit.mjs';

const AUDIT = path.resolve('scripts/audit.mjs');

test('runAudit assembles the full inventory', async () => {
  const r = fx();
  const inv = await runAudit(r);
  assert.equal(inv.days, 30);
  assert.ok(inv.generatedAt);
  assert.equal(inv.host.platform, process.platform);
  assert.equal(inv.claude.skills.length, 6);
  assert.equal(inv.codex.config.model, 'gpt-6-astra');
  assert.equal(inv.usage.claude.skills['alpha:brainstorming'], 2);
  assert.equal(inv.usage.codex.mcpServers.pal, 2);
  assert.equal(inv.startupCost.claude.mcpToolNames, null);
  assert.ok(inv.facts.find(f => f.key === 'codex.model').conflict);
  assert.ok(Array.isArray(inv.warnings));
});

test('CLI writes inventory.json to --out and prints a summary', () => {
  const r = fx();
  const out = execFileSync('node', [AUDIT, '--home', r.home, '--out', r.out, '--cwd', r.cwd], { encoding: 'utf8' });
  assert.match(out, /inventory written to/);
  assert.match(out, /Claude Code\s+skills 5 loaded \(1 in disabled plugins\)/);
  assert.match(out, /Codex CLI\s+skills 1/);
  assert.match(out, /model gpt-6-astra \/ high/);
  const inv = JSON.parse(fs.readFileSync(path.join(r.out, 'inventory.json'), 'utf8'));
  assert.equal(inv.claude.plugins.length, 2);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/audit.test.mjs`
Expected: 4 new failures

- [ ] **Step 3: Implement `scripts/audit.mjs`**

```js
#!/usr/bin/env node
// scripts/audit.mjs — harness-audit: inventory a Claude Code + Codex CLI harness. Read-only.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveRoots } from './lib/args.mjs';
import { collectClaude } from './lib/claude.mjs';
import { collectCodex } from './lib/codex.mjs';
import { usageClaude, usageCodex } from './lib/usage.mjs';
import { startupCost, extractFacts } from './lib/analysis.mjs';

const version = (cmd) => { try { return execFileSync(cmd, ['--version'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0]; } catch { return null; } };
const fmt = n => n == null ? 'unknown' : n.toLocaleString('en-US');
const mb = b => `${(b / 1048576).toFixed(1)} MB`;

export async function runAudit(roots) {
  const sinceMs = Date.now() - roots.days * 86400e3;
  const claude = collectClaude(roots);
  const codex = collectCodex(roots);
  const usage = {
    claude: claude ? await usageClaude(path.join(claude.root, 'projects'), sinceMs) : null,
    codex: codex ? await usageCodex(path.join(codex.root, 'sessions'), sinceMs, codex.mcpServers.map(s => s.name)) : null,
  };
  return {
    generatedAt: new Date().toISOString(),
    days: roots.days,
    cwd: roots.cwd,
    host: { platform: process.platform, node: process.version, claudeCode: version('claude'), codexCli: version('codex') },
    claude, codex, usage,
    startupCost: startupCost(claude, codex),
    facts: extractFacts(claude, codex),
    warnings: [...(claude?.warnings ?? []), ...(codex?.warnings ?? [])],
  };
}

export function summary(inv, outFile) {
  const lines = [`harness-audit inventory written to ${outFile}`, ''];
  const c = inv.claude, k = inv.codex, sc = inv.startupCost;
  if (c) {
    const loaded = c.skills.filter(s => s.loaded).length, off = c.skills.length - loaded;
    lines.push(`Claude Code   skills ${loaded} loaded (${off} in disabled plugins)   agents ${c.agents.filter(a => a.loaded).length}   MCP servers ${c.mcpServers.length}   hooks ${sc.claude.hooks}   sessions(${inv.days}d) ${inv.usage.claude.sessions}`);
    lines.push(`              startup cost estimate: ${fmt(sc.claude.total)} tokens (skills ${fmt(sc.claude.skillList)} · agents ${fmt(sc.claude.agentList)} · instructions ${fmt(sc.claude.instructionFiles)} · MCP tool names: unknown)`);
  } else lines.push('Claude Code   not found');
  if (k) {
    lines.push(`Codex CLI     skills ${k.skills.length}   MCP servers ${k.mcpServers.length}   hooks ${sc.codex.hooks}   sessions(${inv.days}d) ${inv.usage.codex.sessions}   model ${k.config.model ?? '?'} / ${k.config.effort ?? '?'}`);
    lines.push(`              startup cost estimate: ${fmt(sc.codex.total)} tokens`);
  } else lines.push('Codex CLI     not found');
  const clutter = [...(c?.clutter ?? []), ...(k?.clutter ?? [])];
  lines.push(`Conflicts     ${inv.facts.filter(f => f.conflict).length}   Clutter   ${clutter.length} items, ${mb(clutter.reduce((n, x) => n + x.bytes, 0))}   Warnings ${inv.warnings.length}`);
  return lines.join('\n') + '\n';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const roots = resolveRoots(args);
  const inv = await runAudit(roots);
  if (args.json) { process.stdout.write(JSON.stringify(inv, null, 2) + '\n'); return; }
  fs.mkdirSync(roots.out, { recursive: true });
  const outFile = path.join(roots.out, 'inventory.json');
  fs.writeFileSync(outFile, JSON.stringify(inv, null, 2) + '\n');
  process.stdout.write(summary(inv, outFile));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(`harness-audit: ${e.message}`); process.exit(1); });
}
```

- [ ] **Step 4: Run the whole suite**

Run: `npm test`
Expected: all pass (toml 7, lib 7, audit 21)

- [ ] **Step 5: Smoke run against the real home, read-only**

Run: `node scripts/audit.mjs --out /tmp/ha-smoke && node -e "const i=require('/tmp/ha-smoke/inventory.json');console.log(i.claude.skills.length, i.codex?.mcpServers.length, i.facts.filter(f=>f.conflict).map(f=>f.key))"`
Expected: a summary block, non-zero skill count, and `codex.model` among the conflicts on the author's machine. If it throws, fix the parser for the real file shape before committing.

- [ ] **Step 6: Commit**

```bash
git add scripts/audit.mjs tests/audit.test.mjs
git commit -m "feat: audit CLI writes inventory.json and prints summary

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Backup, actions and `apply.mjs`

**Files:**
- Create: `scripts/lib/backup.mjs`, `scripts/lib/actions.mjs`, `scripts/apply.mjs`, `tests/apply.test.mjs`

**Interfaces:**
- Plan file (`plan.json`): `PlanItem[]` where `PlanItem = { id, action, target, harness: 'claude'|'codex', reason, manual: boolean, path?: string }`.
  - `disable-plugin`: `target` = plugin name (`small-business`). Sets every `enabledPlugins` key starting with `<target>@` to `false` in `<claudeRoot>/settings.json`.
  - `remove-skill`: `path` = absolute skill directory. Moves it to the backup.
  - `remove-agent`: `path` = absolute agent file. Moves it to the backup.
  - `remove-mcp`: `target` = server name. `harness: 'claude'` removes the key from `mcpServers` in `claudeJson`, then from `<claudeRoot>/settings.json`, then from `settings.local.json`, first hit wins. `harness: 'codex'` removes `[mcp_servers.<target>]` and sub-tables from `config.toml`.
  - `remove-hook`: `target` = exact command string, `path` = the settings file. Removes every hook whose `command` equals target from that file; drops empty groups and empty events.
  - `delete-clutter`: `path` = file or directory. Moves it to the backup. For `dead-project-entry` items use `prune-codex-projects` instead.
  - `prune-codex-projects`: removes every `[projects."p"]` table whose `p` does not exist from `config.toml`.
  - `edit-instructions`: always `manual: true`; `path` + `reason` printed, never executed.
- Produces (`backup.mjs`): `createBackup(outDir, stamp): Backup` with `backup.add(absPath)` (copies file or directory into `<outDir>/backups/<stamp>/<encoded path>` and records it in the manifest, no-op if already added or missing), `backup.move(absPath)` (same but moves), `backup.finish()` writes `manifest.json = { stamp, createdAt, finishedAt, entries: [{ original, stored, mode: 'copy'|'move', mtimeMs }] }`. `restoreBackup(outDir, stamp, { force }): { restored: string[], conflicts: string[] }` — copies every entry back; a `copy` entry whose original mtime is more than 1 s newer than the manifest's `finishedAt` (the moment apply ended) is a conflict and skipped unless `force`; a `move` entry is moved back. `listBackups(outDir): { stamp, createdAt, entries }[]`.
  - Path encoding for `stored`: `original.replace(/[\/\\:]/g, '__')`.
- Produces (`actions.mjs`): `applyItem(item, roots, backup): { changed: string[], note?: string }`; throws `Error` with a clear message on unknown action or missing target. Also `MANUAL_ACTIONS = ['edit-instructions']`.
- Produces (`apply.mjs` CLI):
  - `--plan FILE --ids A,B [--yes] [--dry-run]` plus the root flags. Loads the plan, validates ids exist (unknown id exits 2). Manual ids print their instruction and exit 2 without touching anything unless other ids remain, in which case they are reported and skipped. When `!process.stdin.isTTY && !--yes` exits 2 with `refused: not a TTY, pass --yes after confirming in chat`. TTY without `--yes` prompts `Apply <id> <action> <target>? [y/N]` per item via `readline`.
  - Stamp: `new Date().toISOString().replace(/[:.]/g, '-')`.
  - Prints one line per applied item, then `backup: <dir>` and `undo: node <this file> --undo <stamp> --out <out>`.
  - `--undo STAMP [--force]`, `--list-backups`.
  - Stops at the first failing action, keeps the backup, prints the undo command, exits 1.

- [ ] **Step 1: Write the failing tests**

```js
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

const APPLY = path.resolve('scripts/apply.mjs');
const fx = () => buildFixture(fs.mkdtempSync(path.join(os.tmpdir(), 'ha-apply-')));
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const rootFlags = r => ['--home', r.home, '--out', r.out, '--cwd', r.cwd];

function writePlan(r, items) {
  fs.mkdirSync(r.out, { recursive: true });
  const p = path.join(r.out, 'plan.json');
  fs.writeFileSync(p, JSON.stringify(items));
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

test('actions: disable-plugin flips only the target flag', () => {
  const r = fx();
  const b = createBackup(r.out, 's');
  const res = applyItem({ id: 'P1', action: 'disable-plugin', target: 'alpha', harness: 'claude', manual: false }, r, b);
  const s = readJson(path.join(r.claudeRoot, 'settings.json'));
  assert.equal(s.enabledPlugins['alpha@mk'], false);
  assert.equal(s.enabledPlugins['beta@mk'], false);
  assert.equal(s.hooks.PreToolUse.length, 2);
  assert.deepEqual(res.changed, [path.join(r.claudeRoot, 'settings.json')]);
});

test('actions: remove-mcp claude removes from ~/.claude.json, codex removes toml block', () => {
  const r = fx();
  const b = createBackup(r.out, 's');
  applyItem({ id: 'P2', action: 'remove-mcp', target: 'pal', harness: 'claude', manual: false }, r, b);
  assert.equal(readJson(r.claudeJson).mcpServers.pal, undefined);
  assert.ok(readJson(r.claudeJson).projects);
  applyItem({ id: 'P3', action: 'remove-mcp', target: 'pal', harness: 'codex', manual: false }, r, b);
  const toml = fs.readFileSync(path.join(r.codexRoot, 'config.toml'), 'utf8');
  assert.doesNotMatch(toml, /mcp_servers\.pal/);
  assert.match(toml, /\[mcp_servers\.basic-memory\]/);
  assert.equal(parseToml(toml).model, 'gpt-6-astra');
});

test('actions: remove-skill and delete-clutter move to backup; remove-hook drops the command', () => {
  const r = fx();
  const b = createBackup(r.out, 's');
  const skill = path.join(r.claudeRoot, 'skills', 'grilling');
  applyItem({ id: 'P4', action: 'remove-skill', path: skill, harness: 'claude', manual: false }, r, b);
  assert.equal(fs.existsSync(skill), false);
  const bak = path.join(r.claudeRoot, 'settings.json.bak-1');
  applyItem({ id: 'P5', action: 'delete-clutter', path: bak, harness: 'claude', manual: false }, r, b);
  assert.equal(fs.existsSync(bak), false);
  const settings = path.join(r.claudeRoot, 'settings.json');
  applyItem({ id: 'P6', action: 'remove-hook', target: 'node guard2.js', path: settings, harness: 'claude', manual: false }, r, b);
  const s = readJson(settings);
  assert.deepEqual(s.hooks.PreToolUse.flatMap(g => g.hooks.map(h => h.command)), ['node guard1.js', 'node guard3.js']);
  b.finish();
  assert.equal(fs.existsSync(path.join(r.out, 'backups', 's', 'manifest.json')), true);
});

test('actions: prune-codex-projects removes only dead entries', () => {
  const r = fx();
  const b = createBackup(r.out, 's');
  applyItem({ id: 'P7', action: 'prune-codex-projects', harness: 'codex', manual: false }, r, b);
  const t = parseToml(fs.readFileSync(path.join(r.codexRoot, 'config.toml'), 'utf8'));
  assert.deepEqual(Object.keys(t.projects), [r.cwd]);
});

test('actions: unknown action throws', () => {
  const r = fx();
  assert.throws(() => applyItem({ id: 'X', action: 'nuke', manual: false }, r, createBackup(r.out, 's')), /unknown action/);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/apply.test.mjs`
Expected: FAIL, cannot find module `backup.mjs`

- [ ] **Step 3: Implement `scripts/lib/backup.mjs`**

```js
// scripts/lib/backup.mjs
import fs from 'node:fs';
import path from 'node:path';

const encode = p => p.replace(/[\/\\:]/g, '__');

export function createBackup(outDir, stamp) {
  const dir = path.join(outDir, 'backups', stamp);
  const entries = [];
  const createdAt = Date.now();
  const store = (original, mode) => {
    if (!fs.existsSync(original) || entries.some(e => e.original === original)) return;
    fs.mkdirSync(dir, { recursive: true });
    const stored = path.join(dir, encode(original));
    const mtimeMs = fs.statSync(original).mtimeMs;
    if (mode === 'copy') fs.cpSync(original, stored, { recursive: true });
    else fs.renameSync(original, stored);
    entries.push({ original, stored, mode, mtimeMs });
  };
  return {
    dir,
    add: p => store(p, 'copy'),
    move: p => store(p, 'move'),
    finish: () => {
      if (entries.length === 0) return null;
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ stamp, createdAt, finishedAt: Date.now(), entries }, null, 2) + '\n');
      return dir;
    },
  };
}

export function listBackups(outDir) {
  const root = path.join(outDir, 'backups');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter(s => fs.existsSync(path.join(root, s, 'manifest.json')))
    .map(s => JSON.parse(fs.readFileSync(path.join(root, s, 'manifest.json'), 'utf8')))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function restoreBackup(outDir, stamp, { force = false } = {}) {
  const manifestPath = path.join(outDir, 'backups', stamp, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`no backup with stamp ${stamp}`);
  const { finishedAt, entries } = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const restored = [], conflicts = [];
  for (const e of entries) {
    if (e.mode === 'copy' && !force && fs.existsSync(e.original) && fs.statSync(e.original).mtimeMs > finishedAt + 1000) { conflicts.push(e.original); continue; }
    fs.mkdirSync(path.dirname(e.original), { recursive: true });
    if (fs.existsSync(e.original)) fs.rmSync(e.original, { recursive: true, force: true });
    if (e.mode === 'copy') fs.cpSync(e.stored, e.original, { recursive: true });
    else fs.renameSync(e.stored, e.original);
    restored.push(e.original);
  }
  return { restored, conflicts };
}
```

- [ ] **Step 4: Implement `scripts/lib/actions.mjs`**

```js
// scripts/lib/actions.mjs
import fs from 'node:fs';
import path from 'node:path';
import { removeTable, listTables } from './toml.mjs';

export const MANUAL_ACTIONS = ['edit-instructions'];

const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
const need = (v, what) => { if (!v) throw new Error(`plan item missing ${what}`); return v; };

function editJson(file, backup, fn) {
  if (!fs.existsSync(file)) return false;
  const obj = readJson(file);
  if (!fn(obj)) return false;
  backup.add(file);
  writeJson(file, obj);
  return true;
}

function editText(file, backup, fn) {
  if (!fs.existsSync(file)) return false;
  const before = fs.readFileSync(file, 'utf8');
  const after = fn(before);
  if (after === before) return false;
  backup.add(file);
  fs.writeFileSync(file, after);
  return true;
}

const ACTIONS = {
  'disable-plugin'(item, roots, backup) {
    const file = path.join(roots.claudeRoot, 'settings.json');
    const name = need(item.target, 'target');
    const ok = editJson(file, backup, s => {
      let hit = false;
      for (const k of Object.keys(s.enabledPlugins ?? {})) if (k.split('@')[0] === name && s.enabledPlugins[k] !== false) { s.enabledPlugins[k] = false; hit = true; }
      return hit;
    });
    if (!ok) throw new Error(`plugin ${name} not enabled in ${file}`);
    return { changed: [file] };
  },
  'remove-skill'(item, roots, backup) { const p = need(item.path, 'path'); if (!fs.existsSync(p)) throw new Error(`missing ${p}`); backup.move(p); return { changed: [p] }; },
  'remove-agent'(item, roots, backup) { const p = need(item.path, 'path'); if (!fs.existsSync(p)) throw new Error(`missing ${p}`); backup.move(p); return { changed: [p] }; },
  'delete-clutter'(item, roots, backup) { const p = need(item.path, 'path'); if (!fs.existsSync(p)) throw new Error(`missing ${p}`); backup.move(p); return { changed: [p] }; },
  'remove-mcp'(item, roots, backup) {
    const name = need(item.target, 'target');
    if (item.harness === 'codex') {
      const file = path.join(roots.codexRoot, 'config.toml');
      const ok = editText(file, backup, t => removeTable(t, ['mcp_servers', name]));
      if (!ok) throw new Error(`mcp server ${name} not found in ${file}`);
      return { changed: [file] };
    }
    for (const file of [roots.claudeJson, path.join(roots.claudeRoot, 'settings.json'), path.join(roots.claudeRoot, 'settings.local.json')]) {
      if (editJson(file, backup, o => { if (o.mcpServers && name in o.mcpServers) { delete o.mcpServers[name]; return true; } return false; })) return { changed: [file] };
    }
    throw new Error(`mcp server ${name} not found in claude config files`);
  },
  'remove-hook'(item, roots, backup) {
    const file = need(item.path, 'path'), cmd = need(item.target, 'target');
    const ok = editJson(file, backup, o => {
      const hooks = o.hooks ?? {};
      let hit = false;
      for (const ev of Object.keys(hooks)) {
        hooks[ev] = (hooks[ev] ?? []).map(g => ({ ...g, hooks: (g.hooks ?? []).filter(h => { const drop = h.command === cmd; hit ||= drop; return !drop; }) })).filter(g => g.hooks.length);
        if (!hooks[ev].length) delete hooks[ev];
      }
      return hit;
    });
    if (!ok) throw new Error(`hook "${cmd}" not found in ${file}`);
    return { changed: [file] };
  },
  'prune-codex-projects'(item, roots, backup) {
    const file = path.join(roots.codexRoot, 'config.toml');
    const removed = [];
    const ok = editText(file, backup, t => {
      let out = t;
      for (const tb of listTables(t)) if (tb.path[0] === 'projects' && tb.path.length === 2 && !fs.existsSync(tb.path[1])) { out = removeTable(out, tb.path); removed.push(tb.path[1]); }
      return out;
    });
    if (!ok) return { changed: [], note: 'no dead project entries' };
    return { changed: [file], note: `removed ${removed.length} entries` };
  },
  'edit-instructions'(item) { throw new Error(`${item.id}: manual action, edit ${item.path} by hand: ${item.reason}`); },
};

export function applyItem(item, roots, backup) {
  const fn = ACTIONS[item.action];
  if (!fn) throw new Error(`unknown action ${item.action}`);
  return fn(item, roots, backup);
}
```

- [ ] **Step 5: Implement `scripts/apply.mjs`**

```js
#!/usr/bin/env node
// scripts/apply.mjs — harness-audit: apply approved plan items with backup and undo.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveRoots } from './lib/args.mjs';
import { createBackup, restoreBackup, listBackups } from './lib/backup.mjs';
import { applyItem, MANUAL_ACTIONS } from './lib/actions.mjs';

const SELF = fileURLToPath(import.meta.url);
const refuse = (msg) => { console.error(`refused: ${msg}`); process.exit(2); };
const fail = (msg) => { console.error(`error: ${msg}`); process.exit(1); };

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(res => rl.question(question, res));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const roots = resolveRoots(args);

  if (args.listBackups) {
    for (const b of listBackups(roots.out)) console.log(`${b.stamp}  ${new Date(b.createdAt).toISOString()}  ${b.entries.length} entries`);
    return;
  }
  if (args.undo) {
    const { restored, conflicts } = restoreBackup(roots.out, String(args.undo), { force: args.force === true });
    for (const p of restored) console.log(`restored ${p}`);
    for (const p of conflicts) console.log(`skipped (changed since backup, use --force) ${p}`);
    if (conflicts.length) process.exit(2);
    return;
  }

  if (!args.plan || !args.ids) fail('usage: apply.mjs --plan FILE --ids A,B [--yes] [--dry-run] | --undo STAMP [--force] | --list-backups');
  if (!fs.existsSync(args.plan)) fail(`plan not found: ${args.plan}`);
  const plan = JSON.parse(fs.readFileSync(args.plan, 'utf8'));
  const byId = Object.fromEntries(plan.map(i => [i.id, i]));
  const ids = String(args.ids).split(',').map(s => s.trim()).filter(Boolean);
  const unknown = ids.filter(id => !byId[id]);
  if (unknown.length) refuse(`unknown plan ids: ${unknown.join(', ')}`);
  const items = ids.map(id => byId[id]);
  const manual = items.filter(i => i.manual || MANUAL_ACTIONS.includes(i.action));
  for (const m of manual) console.log(`${m.id} ${m.action}: manual — edit ${m.path ?? m.target} by hand: ${m.reason}`);
  const runnable = items.filter(i => !manual.includes(i));
  if (!runnable.length) refuse('only manual items selected; nothing to apply');
  if (!args.yes && !process.stdin.isTTY) refuse('not a TTY, pass --yes after confirming in chat');

  if (args.dryRun) {
    for (const i of runnable) console.log(`dry-run ${i.id} ${i.action} ${i.target ?? i.path ?? ''}`);
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = createBackup(roots.out, stamp);
  for (const item of runnable) {
    if (!args.yes && !(await confirm(`Apply ${item.id} ${item.action} ${item.target ?? item.path ?? ''}? [y/N] `))) { console.log(`skipped ${item.id}`); continue; }
    try {
      const res = applyItem(item, roots, backup);
      console.log(`${item.id} ${item.action} ${item.target ?? item.path ?? ''}${res.note ? ` (${res.note})` : ''}`);
    } catch (e) {
      backup.finish();
      console.error(`error: ${item.id} ${e.message}`);
      console.error(`undo: node ${SELF} --undo ${stamp} --out ${roots.out}`);
      process.exit(1);
    }
  }
  const dir = backup.finish();
  if (dir) { console.log(`backup: ${dir}`); console.log(`undo: node ${SELF} --undo ${stamp} --out ${roots.out}`); }
  else console.log('nothing changed');
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) main().catch(e => fail(e.message));
```

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: all pass (apply 10 new)

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/backup.mjs scripts/lib/actions.mjs scripts/apply.mjs tests/apply.test.mjs
git commit -m "feat: apply plan items with backup and undo

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: `SKILL.md` and `README.md`

**Files:**
- Create: `SKILL.md`, `README.md`

**Interfaces:**
- Consumes: `inventory.json` shape (Task 7), `plan.json` item shape (Task 8), CLI flags of both scripts.
- Produces: `~/.harness-audit/report.md` and `~/.harness-audit/plan.json`, written by the model following the skill.

- [ ] **Step 1: Write `SKILL.md`**

```markdown
---
name: harness-audit
description: Audit a Claude Code and Codex CLI harness for overlapping skills, dead weight, conflicting instructions, startup token cost, hook stacking and clutter. Use when the user asks to audit, clean up, slim down or measure their harness, asks what skills or MCP servers overlap or can be removed, or runs /harness-audit. The "apply" mode removes approved items with backup and undo.
---

# harness-audit

Two modes. Default is **report**. Run **apply** only when the user asks to apply, remove or clean up after seeing a report.

Paths: `SKILL_DIR` is the directory containing this file. `OUT` is `~/.harness-audit`.

## Report mode

1. Run `node "$SKILL_DIR/scripts/audit.mjs"`. If it exits non-zero, show the error and stop.
2. Read `OUT/inventory.json`. Do not read skill bodies or transcripts yourself; everything you need is in the inventory. Usage counts are a lower bound over the last `days` days.
3. Classify every loaded skill and agent (both harnesses) into exactly one category using only `id` and `description`:
   `debug`, `review`, `plan`, `memory`, `browser`, `docs-lookup`, `git`, `deploy`, `ui-design`, `test`, `security`, `writing`, `project-mgmt`, `domain-specific`, `other`.
4. **Overlapping**: for each category with two or more members from different `source` values, one finding. List members with their usage count from `usage.<harness>.skills` / `usage.<harness>.agents`. Recommend keeping the most used; tie goes to the member whose plugin the user keeps for other reasons. Everything else in the cluster becomes a plan item (`remove-skill` for user skills, `disable-plugin` when every loaded skill of that plugin is unused, otherwise a manual note).
5. **Removable** (dead weight): plugins whose loaded skills, agents and MCP servers all have zero usage; user skills, agents and MCP servers with zero usage. Group by plugin so the recommendation reads "disable plugin X (45 skills, 0 uses in 30 days)". Skip anything installed less than 7 days ago (`plugins[].installedAt` when present).
6. **Needs adjustment**: every `facts[]` entry with `conflict: true`, quoting file, line and both values. Then read the instruction files listed in `claude.instructionFiles` and `codex.instructionFiles` and list up to five prose contradictions between them or against the config, quoting the two lines. Hook events with three or more entries go here with the commands. Every item here is `edit-instructions` (manual) or `remove-hook`.
7. **Clutter**: `claude.clutter` and `codex.clutter` grouped by kind with total bytes. Plan items: `delete-clutter` for files and directories, `prune-codex-projects` once for all `dead-project-entry` items.
8. Write `OUT/report.md`:

```
# Harness audit — <generatedAt>

## Scoreboard
| | Claude Code | Codex CLI |
|---|---|---|
| Startup cost estimate (tokens) | ... | ... |
| Skills loaded | ... | ... |
| Agents | ... | ... |
| MCP servers | ... | ... |
| Hooks | ... | ... |
| Sessions in window | ... | ... |
MCP tool-name cost is not included; servers must be launched to know it.

## Overlapping
## Removable
## Needs adjustment
## Clutter

## Apply plan
```json
[ { "id": "P1", "action": "disable-plugin", "target": "small-business", "harness": "claude", "reason": "45 skills, 0 uses in 30 days", "manual": false } ]
```
```

   Every finding has an id (`P1`, `P2`, ...), a one-sentence reason in plain language, and the exact plan item. Also write the same array to `OUT/plan.json`.
   Plan item fields: `id`, `action` (`disable-plugin`, `remove-skill`, `remove-agent`, `remove-mcp`, `remove-hook`, `delete-clutter`, `prune-codex-projects`, `edit-instructions`), `target` (plugin, server or hook command), `path` (absolute path for skill, agent, clutter, hook file, instruction file), `harness` (`claude` or `codex`), `reason`, `manual` (true only for `edit-instructions`).
9. In chat: the scoreboard, the five highest-impact recommendations with their ids, and the path to the report. Do not paste the whole report. Say that `apply` is available and that every apply is backed up and undoable.

## Apply mode

1. If `OUT/plan.json` is missing or older than 24 hours, run report mode first.
2. Show the plan items as a numbered list with id, action, target and reason. Ask which ids to apply. Never assume all. Manual items cannot be applied; say so.
3. Run `node "$SKILL_DIR/scripts/apply.mjs" --plan "$OUT/plan.json" --ids <ids> --yes`.
4. Show the script output verbatim: applied items, backup directory and the undo command. Tell the user to restart Claude Code or Codex for the change to take effect.

## Undo

`node "$SKILL_DIR/scripts/apply.mjs" --list-backups` lists stamps. `node "$SKILL_DIR/scripts/apply.mjs" --undo <stamp>` restores. Add `--force` only if the user confirms overwriting files changed after the backup.

## Never

- Never delete anything outside apply mode, and never without the script's backup.
- Never edit `CLAUDE.md` or `AGENTS.md`; point at the lines.
- Never send inventory or transcripts anywhere. Everything stays on the machine.
```

- [ ] **Step 2: Write `README.md`**

```markdown
# harness-audit

Find what overlaps, what is dead weight and what contradicts itself in your Claude Code and Codex CLI setup. Then remove it, with a backup and an undo.

Your harness costs tokens before you type a word: every skill description, agent description, MCP tool name and instruction file is loaded into the system prompt of every session. Plugins you installed to try once are still paying that tax. This tool measures it and tells you what to cut.

## What it reports

- **Overlapping** — skills and agents that do the same job under different names (four debug skills, eight review skills, five memory systems).
- **Removable** — plugins, skills, agents and MCP servers with zero use in the last 30 days.
- **Needs adjustment** — instruction files that contradict the config (your `CLAUDE.md` says one model, your `config.toml` says another), events with three or more hooks stacked.
- **Startup cost** — an estimate of tokens spent per session before your first message.
- **Clutter** — backup copies, temp clones, orphaned plugin versions, dead project entries.

## Install

Requires Node.js 18+, which Claude Code and Codex already require.

```bash
git clone https://github.com/<owner>/harness-audit ~/.claude/skills/harness-audit
ln -s ~/.claude/skills/harness-audit ~/.codex/skills/harness-audit   # optional, for Codex
```

## Use

In Claude Code: `/harness-audit`. In Codex: `$harness-audit`.

The skill runs the inventory script, writes `~/.harness-audit/report.md` and `~/.harness-audit/plan.json`, and shows you the scoreboard and top recommendations.

To remove items: `/harness-audit apply`, then pick the ids you want. Every change is backed up first, and the undo command is printed.

Standalone, without the skill:

```bash
node ~/.claude/skills/harness-audit/scripts/audit.mjs            # writes ~/.harness-audit/inventory.json
node ~/.claude/skills/harness-audit/scripts/audit.mjs --json     # prints it instead
node ~/.claude/skills/harness-audit/scripts/apply.mjs --plan ~/.harness-audit/plan.json --ids P1,P4
node ~/.claude/skills/harness-audit/scripts/apply.mjs --list-backups
node ~/.claude/skills/harness-audit/scripts/apply.mjs --undo <stamp>
```

## What it reads

`~/.claude/settings.json`, `~/.claude.json`, `~/.claude/skills`, `~/.claude/agents`, `~/.claude/plugins`, `~/.claude/CLAUDE.md`, `~/.claude/projects/**/*.jsonl` (transcripts, for usage counts only), `~/.codex/config.toml`, `~/.codex/skills`, `~/.codex/hooks.json`, `~/.codex/AGENTS.md`, `~/.codex/sessions/**/*.jsonl`, and the current project's `CLAUDE.md`, `AGENTS.md`, `.claude/` and `.mcp.json`.

## What it never does

- Never sends anything anywhere. No network calls. No telemetry.
- Never writes outside `~/.harness-audit/` in report mode.
- Never deletes without a backup in `~/.harness-audit/backups/<stamp>/`. Directories are moved, not erased.
- Never edits `CLAUDE.md` or `AGENTS.md`. It points at the lines; you edit.

## Limits

- Usage counts are a lower bound: they count tool calls found in transcripts within the window.
- Startup cost is an estimate (characters / 4) and excludes MCP tool schemas, which require launching each server.
- The TOML reader supports the subset Codex uses. A `config.toml` it cannot parse is reported and left alone.

## Development

```bash
npm test
```

## License

MIT
```

- [ ] **Step 3: Install the skill locally and run the full flow once**

```bash
ln -sfn ~/projects/harness-audit ~/.claude/skills/harness-audit
node ~/.claude/skills/harness-audit/scripts/audit.mjs
```

Expected: summary printed, `~/.harness-audit/inventory.json` exists, `claude.skills` does not contain `harness-audit`.

- [ ] **Step 4: Commit**

```bash
git add SKILL.md README.md
git commit -m "docs: skill instructions and readme

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```
