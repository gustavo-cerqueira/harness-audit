# harness-audit — design

Date: 2026-09-21
Status: approved for implementation

## Purpose

A publishable tool that inspects a developer's Claude Code and Codex CLI harness
and reports what overlaps, what can be removed, and what needs adjusting, so the
harness stays as lean as possible. It also offers an apply step that removes
chosen items after explicit confirmation, with a backup and an undo.

Target audience: developers who install a
handful of plugins and skills, and never measure what that costs them. They
install this as a skill, run one command, and get a report they can act on.

## Non-goals (v1)

- No web UI, no hosted service, no telemetry. Nothing leaves the machine.
- No LLM API calls from the scripts. The judgement step runs inside the user's
  existing Claude Code or Codex session, which they already pay for.
- No cross-user benchmarking.
- No editing of prose instruction files (`CLAUDE.md`, `AGENTS.md`). The report
  points at the conflicting lines; the user edits by hand.
- No support for harnesses other than Claude Code and Codex CLI.

## What "overlap" means

Six distinct problems. The tool detects each with a different method.

| Kind | Meaning | Detector |
|---|---|---|
| Functional overlap | Different skills, agents or MCP servers that do the same job (four debug skills, eight review skills, five memory systems). | Model judgement over names and descriptions, using a fixed category rubric. |
| Instruction conflict | Instruction files state a fact that the config contradicts (memory file says model X, config says model Y), or two loaded instruction sets give opposite orders. | Script extracts config facts and memory-file mentions; model compares. |
| Dead weight | Installed but not invoked in the last 30 days. | Script mines session transcripts for tool calls. |
| Startup tax | Tokens spent before the user types anything: skill list, agent list, MCP tool names, instruction files. | Script estimates from character counts. |
| Hook stacking | Several hooks on one event; every matching tool call runs all of them. | Script counts hooks per event. |
| Clutter | Backup copies, temp clones, stale project entries. | Script pattern-matches file names and checks path existence. |

## Architecture

One repository, installed as a skill directory. Three parts:

```
harness-audit/
  SKILL.md              judgement + report + apply orchestration (model reads this)
  scripts/audit.mjs     facts: inventory, usage, startup cost, conflicts, clutter
  scripts/apply.mjs     executes an approved plan with backup and undo
  scripts/lib/          shared helpers (toml.mjs, frontmatter.mjs, paths.mjs, jsonl.mjs)
  tests/                node --test suites with fixture harness trees
  README.md             install, usage, what it reads, what it never does
  LICENSE               MIT
```

Rule of separation: the script is truth, the skill is opinion. Everything
deterministic lives in the scripts, so it is reproducible across models and
testable without a model. Everything that needs judgement lives in `SKILL.md`.

Runtime: Node.js 18 or newer, no dependencies. Node is a hard requirement of
both Claude Code and Codex CLI, so every target machine already has it.

## Component: `scripts/audit.mjs`

Invocation:

```
node scripts/audit.mjs [--out DIR] [--days N] [--claude-root P] [--codex-root P] [--claude-json P] [--json]
```

Defaults: `--out ~/.harness-audit`, `--days 30`, roots resolved from `$HOME`.
The root overrides exist so tests run against fixture trees and never touch the
real home directory. `--json` prints the inventory to stdout instead of writing.

Output: `<out>/inventory.json`, plus a one-screen summary on stdout.

### What it reads

Claude Code:

- `~/.claude/settings.json`, `~/.claude/settings.local.json`: `enabledPlugins`,
  `hooks`, `mcpServers`, `permissions`.
- `~/.claude.json`: global `mcpServers`, per-project `mcpServers`.
- `~/.claude/skills/*/SKILL.md`, `~/.claude/agents/*.md`: user-level skills and agents.
- `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`: plugin manifest,
  `skills/`, `agents/`, `hooks/`, `.mcp.json`. Only plugins listed in
  `enabledPlugins` count as loaded; the rest are reported as installed-disabled.
- `~/.claude/CLAUDE.md` and, when run inside a project, `./CLAUDE.md`,
  `./.claude/settings.json`, `./.claude/skills/`, `./.mcp.json`.
- `~/.claude/projects/**/*.jsonl`: session transcripts, for usage.

Codex CLI:

- `~/.codex/config.toml`: `model`, `model_reasoning_effort`, `[mcp_servers.*]`,
  `[projects."path"]`, `[features]`.
- `~/.codex/skills/*/SKILL.md`, `~/.codex/agents/`, `~/.codex/hooks.json`.
- `~/.codex/AGENTS.md` and, when run inside a project, `./AGENTS.md`.
- `~/.codex/sessions/**/*.jsonl`: rollouts, for usage.

Files are read only. The script never writes outside `--out`.

### Inventory schema

```json
{
  "generatedAt": "ISO-8601",
  "days": 30,
  "host": { "platform": "darwin", "node": "v22.21.1", "claudeCode": "2.1.278", "codexCli": "0.154.0" },
  "claude": {
    "root": "/Users/x/.claude",
    "plugins": [ { "name": "superpowers", "marketplace": "claude-plugins-official", "enabled": true, "path": "...", "skills": 14, "agents": 0, "hooks": 3, "mcpServers": 0 } ],
    "skills":  [ { "id": "superpowers:brainstorming", "name": "brainstorming", "description": "...", "source": "plugin:superpowers", "path": "...", "descriptionChars": 210 } ],
    "agents":  [ { "id": "gsd-planner", "description": "...", "source": "user", "path": "..." } ],
    "hooks":   { "PreToolUse": [ { "command": "...", "source": "settings.json" } ] },
    "mcpServers": [ { "name": "pal", "source": "~/.claude.json", "transport": "stdio", "command": "..." } ],
    "instructionFiles": [ { "path": "~/.claude/CLAUDE.md", "words": 2464, "tokensEst": 3300 } ],
    "clutter": [ { "path": "...", "kind": "backup", "bytes": 12000 } ]
  },
  "codex": {
    "root": "/Users/x/.codex",
    "config": { "model": "gpt-6-astra", "effort": "high", "projects": [ { "path": "...", "exists": false } ] },
    "skills": [], "agents": [], "hooks": {}, "mcpServers": [], "instructionFiles": [], "clutter": []
  },
  "usage": {
    "claude": { "sessions": 41, "skills": { "superpowers:brainstorming": 7 }, "mcpTools": { "mcp__pal__chat": 3 }, "mcpServers": { "pal": 3 }, "agents": { "Explore": 12 } },
    "codex":  { "sessions": 12, "skills": { "web-fetch-router": 2 }, "mcpTools": {}, "mcpServers": {} }
  },
  "startupCost": {
    "claude": { "skillList": 18200, "agentList": 4100, "mcpToolNames": null, "instructionFiles": 3300, "total": 25600 },
    "codex":  { "skillList": 600, "mcpToolNames": 0, "instructionFiles": 2100, "total": 2700 }
  },
  "warnings": [ { "path": "...", "message": "..." } ],
  "facts": [
    { "key": "codex.model", "config": "gpt-6-astra", "mentions": [ { "file": "~/.claude/CLAUDE.md", "line": 38, "value": "gpt-5.6-terra" } ], "conflict": true }
  ]
}
```

Skill ids follow Claude Code's own convention: user skills are bare (`grilling`),
plugin skills are `plugin:name` (`superpowers:brainstorming`). The audit skill
itself is excluded from every list.

### Usage mining

Claude Code transcripts: each line is a JSON object. Lines whose `message.content`
contains a `tool_use` block are counted by `name`. `Skill` calls count toward
`input.skill`. `Agent` calls count toward `input.subagent_type`. Names starting
with `mcp__` count toward the tool and toward the server (second segment).
Only files whose mtime falls within `--days` are opened. Files are streamed line
by line with `readline`; lines without the substring `tool_use` are skipped
before parsing. A malformed line is skipped, never fatal.

Codex rollouts: same streaming. Items with `payload.type` of `function_call`
or `custom_tool_call` are counted by `name`. Skill use is inferred from any
`skills/<name>/SKILL.md` path appearing in the rollout, counted once per file.

Usage is a lower bound. The report says so.

### Startup cost estimate

`tokensEst = ceil(chars / 4)`. Components:

- skill list: for each loaded skill, `len(id) + min(len(description), 300) + 6`
- agent list: for each agent, `len(id) + len(description) + 6`
- MCP tool names: unknown without launching servers. The script reports server
  count and marks tool-name cost as `null` unless a cached tool list exists
  under `~/.claude/` (checked opportunistically). The report states the gap.
- instruction files: global plus project files that Claude Code would load from
  the current directory.

The number is labeled an estimate everywhere it appears.

### Facts and conflicts

The script extracts a fixed set of config facts and scans instruction files for
mentions of the same kind of value:

- `codex.model`, `codex.effort` from `config.toml`; mentions of `model =` or
  `model_reasoning_effort =` or a model id pattern (`gpt-`, `claude-`, `o[0-9]`)
  inside `CLAUDE.md` / `AGENTS.md`.
- `claude.mcpServers` names vs server names mentioned in instruction files that
  are not configured anywhere.
- `claude.enabledPlugins` vs plugin names mentioned in instruction files that
  are disabled or absent.

A fact is a conflict when a mention differs from the config value. The model
handles prose-level contradictions in `SKILL.md`; the script only handles values.

### Clutter patterns

- `*.bak*`, `*.backup*`, `*.orig`, `*~` under `~/.claude/` and `~/.codex/`, depth 1
- `~/.claude/plugins/cache/temp_*`
- Codex `[projects."path"]` entries whose path does not exist
- `~/.claude/projects/<slug>/` directories whose decoded path does not exist

Each entry carries `kind`, `path`, `bytes`.

## Component: `SKILL.md`

Frontmatter: `name: harness-audit`, description covering the trigger phrases
(audit my harness, what can I remove, overlapping skills, harness cost, clean
up my Claude Code / Codex setup). The same file works in `~/.claude/skills/`
and `~/.codex/skills/`; instructions are harness-neutral and refer to scripts
relative to the skill's own directory.

Two modes. Default is `report`. `apply` runs only when the user says so.

### Report mode

1. Run `node <skill-dir>/scripts/audit.mjs`. Stop and show the error if it fails.
2. Read `~/.harness-audit/inventory.json`.
3. Classify every skill and agent into one of a fixed category list:
   `debug`, `review`, `plan`, `memory`, `browser`, `docs-lookup`, `git`,
   `deploy`, `ui-design`, `test`, `security`, `writing`, `project-mgmt`,
   `domain-specific`, `other`. Use name and description only. Do not read skill
   bodies unless two members of a cluster look identical.
4. For each category with two or more members from different sources, emit an
   overlap finding: list members with 30-day usage, name the one to keep (the
   most used, tie broken by the one already in a plugin the user keeps for
   other reasons), and the ones to drop.
5. Dead weight: any plugin, skill, agent or MCP server with zero usage in the
   window. Group by plugin so the recommendation is "disable plugin X (45
   skills, 0 uses)" rather than 45 lines.
6. Conflicts: every `facts[].conflict == true` entry, plus up to five
   prose-level contradictions found by reading the instruction files listed in
   the inventory. Quote the two lines that disagree.
7. Hooks: any event with three or more hooks gets a finding with the commands.
8. Clutter: list from inventory, grouped by kind, with total bytes.
9. Write `~/.harness-audit/report.md` in this shape:

```
# Harness audit — <date>

## Scoreboard
Startup cost estimate, counts of loaded skills / agents / MCP servers / hooks,
sessions in window, per harness. One table.

## Overlapping
## Removable
## Needs adjustment
## Clutter

## Apply plan
```json harness-audit-plan
[ { "id": "P1", "action": "disable-plugin", "target": "small-business", "harness": "claude", "reason": "45 skills, 0 uses in 30 days", "manual": false } ]
```
```

Every finding carries an id and a plain-language reason. The apply plan is
also written as `~/.harness-audit/plan.json`.

10. Print the scoreboard and the top five recommendations in chat, and point to
    the full report. Do not paste the whole report.

### Apply mode

Triggered by `/harness-audit apply` or by the user asking to apply the plan.

1. If `plan.json` is missing or older than 24 hours, run report mode first.
2. Show the plan as a numbered list. Ask which ids to apply. Never assume all.
3. Run `node <skill-dir>/scripts/apply.mjs --plan ~/.harness-audit/plan.json --ids P1,P3`.
4. Show the script output: backup location, what changed, the undo command.

## Component: `scripts/apply.mjs`

Invocation:

```
node scripts/apply.mjs --plan FILE --ids P1,P3 [--yes] [--dry-run] [--claude-root P] [--codex-root P] [--claude-json P]
node scripts/apply.mjs --undo <timestamp>
node scripts/apply.mjs --list-backups
```

Behavior:

- Loads the plan, filters to `--ids`. Refuses ids marked `manual: true` and
  prints the manual instruction instead.
- When stdin is a TTY and `--yes` is absent, prompts `y/N` per item. When not a
  TTY (the skill calls it), `--yes` is required, otherwise it exits 2 with a
  message. Confirmation in the skill path happens in chat before the call.
- Before the first change, creates `~/.harness-audit/backups/<timestamp>/` and
  copies every file it will touch, preserving relative paths. Moved directories
  go there whole. Writes `manifest.json` listing original paths.
- `--dry-run` prints what would happen and writes nothing.

Actions:

| action | what it does |
|---|---|
| `disable-plugin` | sets `enabledPlugins[name] = false` in `~/.claude/settings.json`. Nothing is uninstalled. |
| `remove-skill` | moves the skill directory to the backup. |
| `remove-agent` | moves the agent file to the backup. |
| `remove-mcp` | deletes the key from `mcpServers` in `~/.claude.json` or `settings.json`, or removes the `[mcp_servers.X]` block (and its sub-tables) from `config.toml`. |
| `remove-hook` | removes the matching hook entry from `settings.json` or `hooks.json`; removes the event key when empty. |
| `delete-clutter` | moves the file or directory to the backup. |
| `prune-codex-projects` | removes `[projects."path"]` blocks whose path does not exist from `config.toml`. |
| `edit-instructions` | always `manual: true`. The script prints file, line and the suggested change. |

JSON files are rewritten with two-space indent. `config.toml` is edited by
removing whole lines between the target header and the next header of equal or
higher level; every other line is preserved byte for byte. The TOML helper only
supports the subset the harness files use (bare tables, dotted tables, quoted
table keys, string, number, boolean and array values). A file it cannot parse
is reported and left alone.

Undo: `--undo <timestamp>` copies every file in the backup back to its original
path and moves directories back. It refuses if a target file changed after the
backup (mtime newer than the backup's manifest time) unless `--force`.

Exit codes: 0 success, 1 error, 2 refused (missing `--yes` without a TTY,
manual-only ids, undo conflict).

## Installation

```
git clone https://github.com/<owner>/harness-audit ~/.claude/skills/harness-audit
ln -s ~/.claude/skills/harness-audit ~/.codex/skills/harness-audit   # optional, Codex
```

Then `/harness-audit` in Claude Code, or `$harness-audit` in Codex. The scripts
also run standalone: `node ~/.claude/skills/harness-audit/scripts/audit.mjs`.

The README states plainly: reads config and transcripts locally, writes only to
`~/.harness-audit/`, never uploads, never deletes without a backup, undo command
shown after every apply.

## Testing

`node --test tests/`. No framework, no dependencies.

Fixtures under `tests/fixtures/`: a fake `claude/` tree (settings with plugins
and hooks, two user skills, one plugin with three skills, one agent, backups, a
temp clone, two transcripts with dated tool calls) and a fake `codex/` tree
(`config.toml` with two MCP servers and one dead project, one skill, a rollout).
Fixture transcripts use timestamps relative to test time so the 30-day window
stays valid; the test writes them at setup and touches the mtimes.

Suites:

- `audit.test.mjs`: inventory finds every fixture item with the right source;
  disabled plugin is listed as disabled and excluded from startup cost; usage
  counts match the fixture calls; calls outside the window are ignored;
  `codex.model` conflict is detected; clutter finds backups, temp clone and the
  dead project; `--json` output validates against the schema keys above.
- `apply.test.mjs`: on a copy of the fixture, `disable-plugin` flips the flag
  and leaves other keys untouched; `remove-mcp` removes only the target TOML
  block; `remove-skill` moves the directory; backup manifest lists every
  touched path; `--undo` restores byte-identical files; non-TTY without `--yes`
  exits 2; manual ids are refused.
- `toml.test.mjs`: round-trip of the subset, block removal preserves unrelated
  lines and comments.

## Error handling

- Missing harness (no `~/.codex`) is a normal state: that section is `null` in
  the inventory and skipped in the report.
- Unreadable or malformed JSON/TOML: recorded under `inventory.warnings[]` with
  the path, processing continues.
- Transcript scan is bounded by mtime; a directory larger than 5 GB inside the
  window logs a warning and continues.
- `apply.mjs` stops at the first failed action, leaves the backup in place, and
  prints the undo command.

## Open points resolved

- Report-only versus apply: both. Apply is opt-in, id-scoped, backed up, undoable.
- Language: all code, docs and README in English. The repository is public on
  the author's GitHub profile.
- Runtime: Node, not Python or Bash, because Node is guaranteed wherever
  Claude Code or Codex is installed.
