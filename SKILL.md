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
   With hundreds of items, do not read them one by one from the JSON. Print a compact listing with a script (id, source, usage count, first 120 characters of description; for example `node -e` over `inventory.json`), classify from that listing in batches, and read a skill body only to break a tie inside a cluster.
   Codex `agents/*.toml` files are delegation profiles, not skills; before recommending one for removal, check whether `~/.codex/AGENTS.md` names it, and if it does, leave it out of the plan.
4. **Overlapping**: for each category with two or more members from different `source` values, one finding. Overlap findings apply to every category except `other` and `domain-specific`; those two are catch-alls and members there are not overlap candidates. List members with their usage count from `usage.<harness>.skills` / `usage.<harness>.agents`. Recommend keeping the most used; tie goes to the member whose plugin the user keeps for other reasons. Everything else in the cluster becomes a plan item (`remove-skill` for user skills, `disable-plugin` when every loaded skill of that plugin is unused, otherwise an `edit-instructions` item with `manual: true` whose reason names the skill to delete by hand).
5. **Removable** (dead weight): plugins whose loaded skills, agents and MCP servers all have zero usage; user skills, agents and MCP servers with zero usage. Group by plugin so the recommendation reads "disable plugin X (45 skills, 0 uses in 30 days)". Skip anything installed less than 7 days ago (`plugins[].installedAt` when present). A plugin with `origin: "synced"` gets a plan item with `action: "disable-plugin"`, `manual: true`, and a reason that says to disable it in the claude.ai plugin settings, because the script cannot switch it off locally.
   Compare `usage.<harness>.mcpServers` keys with the inventory's `mcpServers[].name`. A server with usage but no inventory entry is built in to the CLI (for example `claude-in-chrome`), configured in another project's `.mcp.json`, or since removed; list these under Removable as "used, not configured here" with their counts and no plan item. Do not treat a configured server as unused when usage lists it under a different spelling (plugin servers appear as `<server>` without the plugin prefix).
6. **Needs adjustment**: every `facts[]` entry with `conflict: true`, quoting file, line and both values. Then read the instruction files listed in `claude.instructionFiles` and `codex.instructionFiles` and list up to five prose contradictions between them or against the config, quoting the two lines. Hook events with three or more entries go here with the commands. Every item here is `edit-instructions` (manual) or `remove-hook`.
7. **Clutter**: `claude.clutter` and `codex.clutter` grouped by kind with total bytes. Plan items: `delete-clutter` for files and directories, `prune-codex-projects` once for all `dead-project-entry` items. Emit one `delete-clutter` plan item per clutter entry, using its `path` verbatim. Never emit a parent directory or a representative path for a group: `apply.mjs` moves exactly the path it is given, and a parent path would take live siblings with it (for example all of `~/.claude/projects`). Group only the prose, not the items.
8. If `warnings[]` is non-empty, write a `## Warnings` section before the scoreboard listing each `path: message` and say which sections may be incomplete. Write `OUT/report.md`:

```
# Harness audit — <generatedAt>

## Warnings

## Scoreboard
| | Claude Code | Codex CLI |
|---|---|---|
| Startup cost estimate (tokens) | ... | ... |
| Skills loaded | ... | ... |
| Agents | ... | ... |
| MCP servers | ... | ... |
| Hooks | ... | ... |
| Transcripts in window (includes subagent transcripts) | ... | ... |
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
   Plan item fields: `id`, `action` (`disable-plugin`, `remove-skill`, `remove-agent`, `remove-mcp`, `remove-hook`, `delete-clutter`, `prune-codex-projects`, `edit-instructions`), `target` (plugin, server or hook command), `path` (absolute path for skill, agent, clutter, hook file, instruction file — for `remove-skill` this is the skill's **directory**, the parent of the inventory's `path`, which points at `SKILL.md`), `harness` (`claude` or `codex`), `reason`, `manual` (`true` for `edit-instructions`, for `disable-plugin` on a plugin with `origin: "synced"`, and for `remove-hook` on a hook whose `source` starts with `project:` — project-scope hooks live outside the harness roots and are refused by the script).
9. In chat: the scoreboard, the five highest-impact recommendations with their ids, and the path to the report. Do not paste the whole report. Say that `apply` is available and that every apply is backed up and undoable.

## Apply mode

1. If `OUT/plan.json` is missing or older than 24 hours, run report mode first.
2. Show the plan items as a numbered list with id, action, target and reason. Ask which ids to apply. Never assume all. Manual items cannot be applied; say so.
3. Run `node "$SKILL_DIR/scripts/apply.mjs" --plan "$OUT/plan.json" --ids <ids> --yes`.
4. Show the script output verbatim: applied items, backup directory and the undo command. Tell the user to restart Claude Code or Codex for the change to take effect. If the script prints `error:` lines, show them; the other items still applied and the undo command still covers them.

## Undo

`node "$SKILL_DIR/scripts/apply.mjs" --list-backups` lists stamps. `node "$SKILL_DIR/scripts/apply.mjs" --undo <stamp>` restores. Add `--force` only if the user confirms overwriting files changed after the backup.

## Never

- Never delete anything outside apply mode, and never without the script's backup.
- Never edit `CLAUDE.md` or `AGENTS.md`; point at the lines.
- Never send inventory or transcripts anywhere. Everything stays on the machine.
- Never propose removing the harness-audit skill itself or anything under `~/.harness-audit`.
- Never put a directory in a plan item unless the inventory lists that exact directory as a clutter entry or a skill/agent path.
