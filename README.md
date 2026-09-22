# harness-audit

Inspect your Claude Code and Codex setup for overlapping capabilities, instruction inconsistencies and clutter. Review the evidence, then apply selected cleanup items with backups and conflict-aware undo.

The audit separates deterministic inventory from model judgement. It does not treat missing usage as proof that a component is disposable, or tools in the same category as interchangeable.

## What it reports

- **Overlap candidates** — tools with potentially replaceable capabilities, including duplicates from the same source. Complementary workflow steps are kept separate.
- **Observed usage** — timestamped calls and recognized skill reads found in local transcripts. Unsupported or ambiguous activity is marked unknown.
- **Needs adjustment** — instruction candidates checked in context, and hooks with evidence of duplicated work. Counts alone are not removal reasons.
- **Metadata cost** — a character-based estimate of discovered enabled descriptions, paths and instruction text. This is not a measured session prompt or guaranteed savings.
- **Clutter** — backup copies, temp clones, orphaned plugin versions and missing project entries, with exact paths and sizes.

## Install

Requires Node.js 18+ and Git. Native Claude Code or Codex installations do not necessarily include Node.

```bash
git clone https://github.com/gustavo-cerqueira/harness-audit ~/.claude/skills/harness-audit
mkdir -p ~/.codex/skills
ln -s ~/.claude/skills/harness-audit ~/.codex/skills/harness-audit   # optional, for Codex
```

Use your configured harness directories if they differ from these defaults.

## Use

In Claude Code: `/harness-audit`. In Codex: `$harness-audit`.

The skill runs the inventory script, writes `~/.harness-audit/report.md` and `~/.harness-audit/plan.json`, and presents evidence-backed recommendations with coverage limits. An empty cleanup plan is a valid result.

To remove items, request `harness-audit apply` and approve specific IDs. Manual or unsupported sources are not changed. No installed components are removed in report mode.

Standalone commands:

```bash
node ~/.claude/skills/harness-audit/scripts/audit.mjs            # inventory.json + summary
node ~/.claude/skills/harness-audit/scripts/audit.mjs --json     # stdout only
node ~/.claude/skills/harness-audit/scripts/audit.mjs --days 7
node ~/.claude/skills/harness-audit/scripts/apply.mjs --plan ~/.harness-audit/plan.json --ids P1,P4
node ~/.claude/skills/harness-audit/scripts/apply.mjs --list-backups
node ~/.claude/skills/harness-audit/scripts/apply.mjs --undo <stamp>
```

The standalone audit produces inventory; the active assistant writes the judgement report and plan. Apply requires a fresh plan object `{ "generatedAt": "<inventory timestamp>", "cwd": "<inventory cwd>", "items": [...] }` and its sibling `inventory.json`. Run apply from the inventoried project directory. Old array-format plans must be regenerated. Noninteractive apply requires `--yes` after explicit approval of the selected IDs.

## Coverage

The collectors inspect supported global and project settings, instruction files, skills, agents, plugins, hooks and MCP (Model Context Protocol) server configuration. Codex discovery includes shared `.agents/skills`, system skills and resolvable enabled plugin installations. Discovery retains source and loading state; unsupported or ambiguous installations produce warnings rather than guessed active versions.

Defaults are `~/.claude`, `~/.claude.json`, and `~/.codex`. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honored; `--home`, `--claude-root`, `--claude-json`, `--codex-root`, `--cwd` and `--out` allow explicit overrides and disposable test homes.

Usage comes from Claude project transcripts and Codex session rollouts. Each event must be timestamped within the requested window. Catalog mentions and skill paths in tool output do not count as execution. Recognized Codex reads are evidence of reading instructions, not proof of completing the workflow. Dynamic commands and unsupported wrapper calls cannot always be attributed. Hook execution is not measured. Read `coverage`, `unknown`, `skipped` and `warnings` before interpreting counts; absence from a map does not establish zero actual use.

## Mutation and privacy boundaries

- Scripts perform no direct network uploads or telemetry. The audit invokes `claude --version` and `codex --version`; those programs may touch their own state.
- Model-assisted reporting reads metadata and selected instructions into the active assistant conversation, subject to that assistant's normal data handling. Treat inventory as private: paths, server commands and URLs may contain sensitive information.
- Report mode writes only under `--out` (default `~/.harness-audit`). It does not edit harness settings.
- Apply validates selected items against the fresh inventory and supported source, then checks live filesystem metadata fingerprints before mutation. Changed targets require a new audit. Instruction files and the audit skill itself are protected. Unsupported scopes require manual changes.
- Backup payloads use unique names and recovery metadata is persisted as changes happen. Undo refuses files changed after apply; `--force` explicitly permits overwriting conflicts. Errors and partial recovery are reported.
- Unsupported TOML syntax is warned about during inventory; destructive TOML edits refuse documents they cannot safely parse. Moving a directory across filesystems may fail and is reported rather than silently deleted.

The tool estimates local configuration, not every runtime-injected or remotely managed component. Tool schemas, dynamic instructions and unknown scopes are excluded from the metadata estimate. Re-audit after harness updates or configuration changes.

## Development

```bash
npm test
```

Tests use disposable fixtures. [Report evaluation cases](docs/report-evaluation.md) check the judgement layer separately; passing script tests alone does not establish model recommendation quality.

## License

MIT
