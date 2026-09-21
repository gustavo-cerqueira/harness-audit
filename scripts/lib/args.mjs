// scripts/lib/args.mjs
import os from 'node:os';
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
  const home = args.home ?? env.HOME ?? os.homedir();
  const days = Number(args.days ?? 30);
  if (!Number.isInteger(days) || days <= 0) throw new Error('--days must be a positive integer');
  return {
    home,
    claudeRoot: args.claudeRoot ?? path.join(home, '.claude'),
    codexRoot: args.codexRoot ?? path.join(home, '.codex'),
    claudeJson: args.claudeJson ?? path.join(home, '.claude.json'),
    out: args.out ?? path.join(home, '.harness-audit'),
    days,
    cwd: args.cwd ?? process.cwd(),
  };
}
