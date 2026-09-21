# harness-audit

Find what overlaps, what is dead weight and what contradicts itself in your Claude Code and Codex CLI setup. Then remove it, with a backup and an undo.

Your harness costs tokens before you type a word: every skill description, agent description, MCP tool name and instruction file is loaded into the system prompt of every session. Plugins you installed to try once are still paying that tax. This tool measures it and tells you what to cut.

## What it reports

- **Overlapping** — skills and agents that do the same job under different names (four debug skills, eight review skills, five memory systems).
- **Removable** — plugins, skills, agents and MCP servers with zero use in the last 30 days (including plugins synced from claude.ai, which you disable in claude.ai).
- **Needs adjustment** — instruction files that contradict the config (your `CLAUDE.md` says one model, your `config.toml` says another), events with three or more hooks stacked.
- **Startup cost** — an estimate of tokens spent per session before your first message.
- **Clutter** — backup copies, temp clones, orphaned plugin versions, dead project entries.

## Install

Requires Node.js 18+, which Claude Code and Codex already require.

```bash
git clone https://github.com/gustavo-cerqueira/harness-audit ~/.claude/skills/harness-audit
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
node ~/.claude/skills/harness-audit/scripts/audit.mjs --days 7   # usage window in days (default 30)
node ~/.claude/skills/harness-audit/scripts/apply.mjs --plan ~/.harness-audit/plan.json --ids P1,P4
node ~/.claude/skills/harness-audit/scripts/apply.mjs --list-backups
node ~/.claude/skills/harness-audit/scripts/apply.mjs --undo <stamp>
```

## What it reads

`~/.claude/settings.json`, `~/.claude/settings.local.json`, `~/.claude.json`, `~/.claude/skills`, `~/.claude/agents`, `~/.claude/plugins`, `~/.claude/plugins/installed_plugins.json`, `~/.claude/plugins/synced`, `~/.claude/CLAUDE.md`, `~/.claude/projects/**/*.jsonl` (transcripts, for usage counts only), `~/.codex/config.toml`, `~/.codex/skills`, `~/.codex/hooks.json`, `~/.codex/AGENTS.md`, `~/.codex/sessions/**/*.jsonl`, and the current project's `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `.claude/` (including `.claude/settings.json`), `.codex/skills` and `.mcp.json`.

## What it never does

- Never sends anything anywhere. No network calls. No telemetry.
- This tool never writes outside `~/.harness-audit/` in report mode.
- Never deletes without a backup in `~/.harness-audit/backups/<stamp>/`. Directories are moved, not erased.
- Never edits `CLAUDE.md` or `AGENTS.md`. It points at the lines; you edit.

## Limits

- Usage counts are a lower bound: they count tool calls found in transcripts within the window.
- Transcript counts include subagent transcripts, so the number is higher than your session count.
- Startup cost is an estimate (characters / 4) and excludes MCP tool schemas, which require launching each server.
- The TOML reader supports the subset Codex uses. A `config.toml` it cannot parse is reported and left alone.
- The audit runs `claude --version` and `codex --version` to record versions; those CLIs may touch their own state files.

## Development

```bash
npm test
```

## License

MIT
