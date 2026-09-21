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
      else if ((e.isFile() || e.isSymbolicLink()) && p.endsWith(ext)) {
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        if (st.mtimeMs >= sinceMs) out.push(p);
      }
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
