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
import { snapshotTargets } from './lib/snapshot.mjs';

const version = (cmd) => { try { return execFileSync(cmd, ['--version'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0]; } catch { return null; } };
const fmt = n => n == null ? 'unknown' : n.toLocaleString('en-US');
const mb = b => `${(b / 1048576).toFixed(1)} MB`;

export async function runAudit(roots) {
  const sinceMs = Date.now() - roots.days * 86400e3;
  const claude = collectClaude(roots);
  const codex = collectCodex(roots);
  const snapshotWarnings = [];
  const targetSnapshots = snapshotTargets(claude, codex, snapshotWarnings);
  const usage = {
    claude: claude ? await usageClaude(path.join(claude.root, 'projects'), sinceMs, claude) : null,
    codex: codex ? await usageCodex(path.join(codex.root, 'sessions'), sinceMs, codex) : null,
  };
  return {
    generatedAt: new Date().toISOString(),
    days: roots.days,
    cwd: roots.cwd,
    host: { platform: process.platform, node: process.version, claudeCode: version('claude'), codexCli: version('codex') },
    claude, codex, usage, targetSnapshots,
    startupCost: startupCost(claude, codex),
    facts: extractFacts(claude, codex),
    warnings: [...(claude?.warnings ?? []), ...(codex?.warnings ?? []), ...(usage.claude?.warnings ?? []), ...(usage.codex?.warnings ?? []), ...snapshotWarnings],
  };
}

export function summary(inv, outFile) {
  const lines = [`harness-audit inventory written to ${outFile}`, ''];
  const c = inv.claude, k = inv.codex, sc = inv.startupCost;
  if (c) {
    const loaded = c.skills.filter(s => s.loaded).length, off = c.skills.length - loaded;
    lines.push(`Claude Code   skills ${loaded} loaded (${off} in disabled plugins)   agents ${c.agents.filter(a => a.loaded).length}   MCP servers ${c.mcpServers.length}   hooks ${sc.claude.hooks}   sessions(${inv.days}d) ${inv.usage.claude.sessions}`);
    lines.push(`              discovered metadata estimate: ${fmt(sc.claude.total)} tokens (skills ${fmt(sc.claude.skillList)} · agents ${fmt(sc.claude.agentList)} · instructions ${fmt(sc.claude.instructionFiles)} · tool schemas/runtime injections: excluded)`);
  } else lines.push('Claude Code   not found');
  if (k) {
    lines.push(`Codex CLI     skills ${k.skills.filter(s => s.loaded === true).length} enabled (${k.skills.filter(s => s.loaded !== true).length} disabled/unknown)   agents ${k.agents.filter(a => a.loaded === true).length}   MCP servers ${k.mcpServers.length}   hooks ${sc.codex.hooks}   sessions(${inv.days}d) ${inv.usage.codex.sessions}   model ${k.config.model ?? '?'} / ${k.config.effort ?? '?'}`);
    lines.push(`              discovered metadata estimate: ${fmt(sc.codex.total)} tokens; not a measured prompt size`);
  } else lines.push('Codex CLI     not found');
  const clutter = [...(c?.clutter ?? []), ...(k?.clutter ?? [])];
  lines.push(`Text candidates ${inv.facts.filter(f => f.candidate).length} (require contextual review)   Clutter ${clutter.length} items, ${mb(clutter.reduce((n, x) => n + x.bytes, 0))}   Warnings ${inv.warnings.length}`);
  lines.push('Usage is observed evidence only; missing calls, unknown scopes and hook activity do not establish that a component is unused.');
  return lines.join('\n') + '\n';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const roots = resolveRoots(args);
  const inv = await runAudit(roots);
  if (args.json) { process.stdout.on('error', e => { if (e.code === 'EPIPE') process.exit(0); throw e; }); process.stdout.write(JSON.stringify(inv, null, 2) + '\n'); return; }
  fs.mkdirSync(roots.out, { recursive: true });
  const outFile = path.join(roots.out, 'inventory.json');
  fs.writeFileSync(outFile, JSON.stringify(inv, null, 2) + '\n');
  process.stdout.write(summary(inv, outFile));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(`harness-audit: ${e.message}`); process.exit(1); });
}
