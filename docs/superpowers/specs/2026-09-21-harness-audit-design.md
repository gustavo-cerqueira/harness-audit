# harness-audit — design

Created: 2026-09-21. Revised: 2026-09-22 after the cross-harness correctness review.

## Purpose and architecture

Inspect a developer's Claude Code and Codex configuration, explain evidence-backed cleanup candidates, and apply only explicitly approved items with recoverable backups.

One repository installed as a skill, with three parts:

- `scripts/audit.mjs`: local discovery, observed transcript events, metadata estimates and candidate text matches.
- `SKILL.md`: contextual judgement, report generation and approval orchestration.
- `scripts/apply.mjs`: deterministic plan validation, supported mutations and undo.

Runtime: Node.js 18+, standard library only. Node is a prerequisite of this tool, not guaranteed by native Claude/Codex installations. There is no service, database or direct model API integration. Model judgement uses the user's current assistant session.

## Evidence boundary

Inventory is an observation of supported configuration, not omniscient runtime truth. Each component retains harness, source, identity, path and loading state. Unsupported or ambiguous scopes generate warnings. Unknown usage is never zero, and a startup catalog reference is never invocation evidence.

Codex discovery includes shared `.agents/skills`, project/ancestor skills, user and system skills, resolvable enabled plugin versions and agent metadata. Claude discovery includes project-local settings, applicable plugin installations and the current project's server configuration. Instruction discovery respects supported ancestor/override rules. Custom roots are taken from `CODEX_HOME`, `CLAUDE_CONFIG_DIR` or explicit flags.

Plugin versions must be selected from configuration/registry evidence, not by treating every cache directory as active. An unresolved source remains unknown/manual. Effective load can also depend on trust, runtime injection and managed configuration beyond the supported sources; disclose those limits.

## Usage and estimates

Stream transcripts and filter individual events by timestamp. File mtime may narrow the files opened, but does not define an event's date. Missing timestamps are excluded and counted as skipped evidence.

Claude skill and agent calls are explicit observations. Codex skill reads require recognized tool inputs and an inventoried path/identity; tool outputs, messages and catalogs are excluded. Unsupported commands/wrappers remain unmeasured. Delegation is attributed only when identifiable. MCP (Model Context Protocol) tools are matched against known source-qualified server metadata; ambiguous names remain unknown. Hooks have no transcript-derived usage measurement.

Startup metadata estimates use complete discovered descriptions, identifiers, paths and instruction text, with characters divided by four. Tool schemas, runtime injections and unknown sources are excluded. The number is not a measured prompt size or guaranteed savings.

## Judgement rules

Categories organize the report; they do not prove two capabilities can replace one another. Compare triggers, inputs, outputs and dependencies, including same-source entries. A security reviewer may complement an implementation reviewer. A referenced role remains useful even without observed calls.

Zero observed invocations alone never generates a removal recommendation. Inspect hooks, skills, agents, servers, instruction references and workflow dependencies before proposing plugin disablement. Recent installations are excluded from this recommendation path.

Regex matches in instructions are candidates for contextual review. Retain file, line, harness and surrounding line. Check negation, examples and delegated profiles before claiming contradiction. Hook counts alone do not establish duplicated work: matchers and purpose matter.

Every recommendation states evidence, scope and consequences. Findings can be informational; an empty action plan is valid. Clutter grouping never changes the exact path of an action. Missing project directories do not make all historical transcripts valueless.

## Report and plan

The audit writes `inventory.json` under `--out` (default `~/.harness-audit`), or prints JSON with `--json`. It never mutates harness settings. The skill writes a Markdown report and a plan next to that inventory.

The report contains warnings/coverage first, a scoreboard labeled as estimates/discovery, overlap candidates, no-observed-invocation candidates, contextual adjustments, clutter and any justified plan items.

Plan format:

```json
{
  "generatedAt": "<exact inventory.generatedAt>",
  "cwd": "<exact inventory.cwd>",
  "items": []
}
```

Each item has an ID, action, harness, inventoried source, evidence-backed reason, manual flag, and exact target/path. Hook identity includes event and matcher. Plain-array legacy plans are regenerated. The executor requires a fresh matching sibling inventory and validates selected targets against it.

Supported action names: `disable-plugin`, `remove-skill`, `remove-agent`, `remove-mcp`, `remove-hook`, `delete-clutter`, `prune-codex-projects`, `edit-instructions`. Prose edits are always manual. Unsupported project, synced or plugin-owned changes remain manual rather than being redirected to a global similarly named target.

## Apply and recovery

Only explicitly approved IDs are runnable. The executor validates plan shape, freshness, source, exact inventoried targets and protected paths before changing files. Live filesystem metadata fingerprints (including recursive directory entries) must match the saved inventory, even for a plan less than 24 hours old. An MCP server in a JSON config is compared by its entry content instead, because Claude Code rewrites `~/.claude.json` continuously. Instruction files, this skill and its recovery directory are never cleanup targets. Config symlinks must not redirect edits outside supported roots.

Backup payload names are unique. Recovery metadata is persisted as operations progress so interruption does not hide completed moves. Edited files retain post-apply content fingerprints; undo refuses later changes, including edits immediately after apply. Force restoration requires explicit approval of overwriting conflicts.

TOML (Tom's Obvious, Minimal Language) inventory supports a conservative subset. Destructive edits require a completely understood document, preserve unrelated tables and remove matching noncontiguous child tables. Unsupported syntax causes refusal, not best-effort rewriting.

Errors are visible. A partial batch has recovery records for completed operations; unsupported cross-filesystem moves fail without silently deleting the source. No claim of unconditional successful undo is made for external damage, storage failures or modified files.

## Privacy

Scripts make no direct uploads or telemetry calls. Version probes execute the installed harness programs, whose side effects are outside this script. Model-assisted reporting places selected metadata/instructions in the existing assistant conversation, under its normal data handling. Inventory can contain sensitive command arguments or URLs and is not a sanitized public artifact. Raw transcripts are not needed by the judgement step.

## Acceptance checks

- Unique backup payloads preserve colliding original path spellings.
- Undo protects immediate post-apply edits and reports conflicts.
- Interrupted batches leave discoverable recovery metadata.
- TOML mutations preserve quoted bracket keys, unrelated sections and noncontiguous table boundaries, or refuse unsupported input.
- Catalog-only paths never increment skill invocation counts; old, future and untimestamped calls do not enter the requested window.
- Discovery covers shared/system/plugin scopes without counting every cached version as loaded.
- Sources survive discovery through validation; unsupported targets do not mutate similarly named global entries.
- Candidate text matches are not automatically promoted to conflicts.
- Script regressions run through `npm test`. Model judgement is checked separately using [report evaluation cases](../../report-evaluation.md); fixture availability alone is not a claim that every model passed.

The original implementation plan is historical; this revised contract and the current code supersede its older assumptions.
