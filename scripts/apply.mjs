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
  const failed = [];
  for (const item of runnable) {
    if (!args.yes && !(await confirm(`Apply ${item.id} ${item.action} ${item.target ?? item.path ?? ''}? [y/N] `))) { console.log(`skipped ${item.id}`); continue; }
    try {
      const res = applyItem(item, roots, backup);
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
