#!/usr/bin/env node
// scripts/apply.mjs — harness-audit: apply approved plan items with backup and undo.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs, resolveRoots } from './lib/args.mjs';
import { createBackup, restoreBackup, listBackups } from './lib/backup.mjs';
import { applyItem, MANUAL_ACTIONS } from './lib/actions.mjs';
import { jsonServerEntry, serverKey, serverSnapshot, targetSnapshot } from './lib/snapshot.mjs';

const SELF = fileURLToPath(import.meta.url);
const refuse = (msg) => { console.error(`refused: ${msg}`); process.exit(2); };
const fail = (msg) => { console.error(`error: ${msg}`); process.exit(1); };
const PLAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw new Error(`invalid ${label}: ${e.message}`); }
}

function samePath(a, b) { return path.resolve(a) === path.resolve(b); }

function checkTargetSnapshots(items, inventory) {
  const checks = new Map();
  for (const item of items) {
    if (item.action === 'remove-mcp' && typeof item.path === 'string' && jsonServerEntry(item.source, item.path)) {
      checks.set(serverKey(item.path, item.target), () => serverSnapshot(item.path, item.target));
      continue;
    }
    const target = item.action === 'disable-plugin' ? item.enabledPath
      : item.action === 'prune-codex-projects' ? path.join(inventory.codex.root, 'config.toml') : item.path;
    if (typeof target !== 'string') throw new Error('plan target has no snapshot; rerun the audit');
    checks.set(path.resolve(target), () => targetSnapshot(target));
  }
  for (const [key, current] of checks) {
    const saved = inventory.targetSnapshots?.[key];
    if (!saved || saved !== current()) throw new Error(`target changed since the audit: ${key}; rerun the audit`);
  }
}

function inventoryHas(item, inventory) {
  const harness = inventory[item.harness] ?? {};
  if (item.action === 'disable-plugin') return item.harness === 'claude'
    && item.source === `plugin:${item.target}`
    && item.enabledSource === 'settings.json'
    && (harness.plugins ?? []).some(p => p.name === item.target && p.enabledSource === item.enabledSource && samePath(p.enabledPath, item.enabledPath));
  if (item.action === 'remove-skill') return (harness.skills ?? []).some(s =>
    s.source === item.source && samePath(path.dirname(s.path), item.path));
  if (item.action === 'remove-agent') return (harness.agents ?? []).some(a =>
    a.source === item.source && samePath(a.path, item.path));
  if (item.action === 'remove-mcp') return (harness.mcpServers ?? []).some(s =>
    s.name === item.target && s.source === item.source && samePath(s.path, item.path));
  if (item.action === 'remove-hook') return Object.entries(harness.hooks ?? {}).some(([event, hooks]) => event === item.event && hooks.some(h =>
    h.command === item.target && h.matcher === item.matcher && h.source === item.source && (!h.path || !item.path || samePath(h.path, item.path))));
  if (item.action === 'delete-clutter') return item.source === `${item.harness}.clutter`
    && (harness.clutter ?? []).some(c => samePath(c.path, item.path));
  if (item.action === 'prune-codex-projects') return item.harness === 'codex' && item.source === 'codex.clutter'
    && Array.isArray(item.paths) && item.paths.length > 0 && item.paths.every(p =>
      (harness.clutter ?? []).some(c => c.kind === 'dead-project-entry' && c.path === `${path.join(harness.root, 'config.toml')}#projects.${p}`));
  return false;
}

function loadApprovedPlan(planPath, roots) {
  const plan = readJson(planPath, 'plan');
  const inventoryPath = path.join(path.dirname(planPath), 'inventory.json');
  if (!plan || Array.isArray(plan) || !Array.isArray(plan.items) || typeof plan.generatedAt !== 'string' || typeof plan.cwd !== 'string')
    throw new Error('plan must be a generated envelope; rerun the audit');
  if (!fs.existsSync(inventoryPath)) throw new Error('sibling inventory.json is missing; rerun the audit');
  const inventory = readJson(inventoryPath, 'inventory');
  if (plan.generatedAt !== inventory.generatedAt || plan.cwd !== inventory.cwd || !samePath(plan.cwd, roots.cwd))
    throw new Error('plan does not match the current inventory and cwd; rerun the audit');
  for (const harness of ['claude', 'codex']) if (inventory[harness]?.root && !samePath(inventory[harness].root, roots[`${harness}Root`]))
    throw new Error(`plan inventory ${harness} root does not match this apply target; rerun the audit`);
  const generatedAt = Date.parse(plan.generatedAt);
  if (!Number.isFinite(generatedAt) || generatedAt > Date.now() || Date.now() - generatedAt > PLAN_MAX_AGE_MS)
    throw new Error('plan is stale; rerun the audit');
  for (const item of plan.items) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.action !== 'string' ||
      !['claude', 'codex'].includes(item.harness) || typeof item.reason !== 'string' || typeof item.manual !== 'boolean')
      throw new Error('plan contains an invalid item; rerun the audit');
    if (!item.manual && typeof item.source !== 'string') throw new Error('plan item is missing source; rerun the audit');
    if (['disable-plugin', 'remove-mcp', 'remove-hook'].includes(item.action) && typeof item.target !== 'string')
      throw new Error('plan item is missing target; rerun the audit');
    if (['remove-skill', 'remove-agent', 'delete-clutter', 'remove-hook', 'remove-mcp'].includes(item.action) && typeof item.path !== 'string')
      throw new Error('plan item is missing path; rerun the audit');
    if (item.action === 'disable-plugin' && (typeof item.enabledSource !== 'string' || typeof item.enabledPath !== 'string')) throw new Error('plan item is missing enabled scope; rerun the audit');
    if (item.action === 'remove-hook' && (typeof item.event !== 'string' || typeof item.matcher !== 'string'))
      throw new Error('plan item is missing hook event or matcher; rerun the audit');
    if (item.action === 'prune-codex-projects' && (!Array.isArray(item.paths) || !item.paths.every(p => typeof p === 'string' && path.isAbsolute(p))))
      throw new Error('plan item is missing dead project paths; rerun the audit');
  }
  if (new Set(plan.items.map(i => i.id)).size !== plan.items.length) throw new Error('plan contains duplicate ids; rerun the audit');
  return { items: plan.items, inventory };
}

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
    for (const b of listBackups(roots.out)) console.log(`${b.stamp}  ${new Date(b.createdAt).toISOString()}  ${b.entries.length} entries${b.incomplete ? '  (interrupted)' : ''}`);
    return;
  }
  if (args.undo) {
    const { restored, conflicts, failed } = restoreBackup(roots.out, String(args.undo), { force: args.force === true });
    for (const p of restored) console.log(`restored ${p}`);
    for (const p of conflicts) console.log(`skipped (changed since backup, use --force) ${p}`);
    for (const f of failed) console.log(`failed ${f.original}: ${f.reason}`);
    if (failed.length) process.exit(1);
    if (conflicts.length) process.exit(2);
    return;
  }

  if (!args.plan || !args.ids) fail('usage: apply.mjs --plan FILE --ids A,B [--yes] [--dry-run] | --undo STAMP [--force] | --list-backups');
  if (!fs.existsSync(args.plan)) fail(`plan not found: ${args.plan}`);
  let approved;
  try { approved = loadApprovedPlan(args.plan, roots); }
  catch (e) { refuse(e.message); }
  const byId = Object.fromEntries(approved.items.map(i => [i.id, i]));
  const ids = String(args.ids).split(',').map(s => s.trim()).filter(Boolean);
  const unknown = ids.filter(id => !byId[id]);
  if (unknown.length) refuse(`unknown plan ids: ${unknown.join(', ')}`);
  const items = ids.map(id => byId[id]);
  const manual = items.filter(i => i.manual || MANUAL_ACTIONS.includes(i.action));
  for (const m of manual) console.log(`${m.id} ${m.action}: manual — edit ${m.path ?? m.target} by hand: ${m.reason}`);
  const runnable = items.filter(i => !manual.includes(i));
  if (!runnable.length) refuse('only manual items selected; nothing to apply');
  const unapproved = runnable.filter(i => !inventoryHas(i, approved.inventory));
  if (unapproved.length) refuse(`plan item is not an exact current inventory finding: ${unapproved.map(i => i.id).join(', ')}`);
  try { checkTargetSnapshots(runnable, approved.inventory); }
  catch (e) { refuse(e.message); }
  if (!args.yes && !process.stdin.isTTY) refuse('not a TTY, pass --yes after confirming in chat');

  if (args.dryRun) {
    for (const i of runnable) console.log(`dry-run ${i.id} ${i.action} ${i.target ?? i.path ?? ''}`);
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = createBackup(roots.out, stamp);
  const failed = [];
  for (const item of runnable) {
    if (!args.yes && !(await confirm(`Apply ${item.id} ${item.action} ${item.target ?? item.path ?? ''}? [y/N] `))) { console.log(`skipped ${item.id}`); continue; }
    try {
      checkTargetSnapshots([item], approved.inventory);
      const res = applyItem(item, roots, backup);
      for (const changed of res.changed) {
        if (fs.existsSync(changed)) approved.inventory.targetSnapshots[path.resolve(changed)] = targetSnapshot(changed);
        else delete approved.inventory.targetSnapshots[path.resolve(changed)];
      }
      console.log(`${item.id} ${item.action} ${item.target ?? item.path ?? ''}${res.note ? ` (${res.note})` : ''}`);
    } catch (e) {
      failed.push({ id: item.id, message: e.message });
      console.error(`error: ${item.id} ${e.message}`);
    }
  }
  const dir = backup.finish();
  if (dir) { console.log(`backup: ${dir}`); console.log(`undo: node ${SELF} --undo ${stamp} --out ${roots.out}`); }
  else console.log('nothing changed');
  if (failed.length) { console.error(`failed: ${failed.length}`); process.exit(1); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) main().catch(e => fail(e.message));
