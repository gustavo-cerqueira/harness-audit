// scripts/lib/toml.mjs
// ponytail: line-based TOML subset (bare/dotted/quoted tables, scalars, flat arrays).
// Enough for ~/.codex/config.toml. Inline tables and multi-line arrays throw.

const HEADER = /^\s*\[([^\]]+)\]\s*(#.*)?$/;
const ARRAY_HEADER = /^\s*\[\[([^\]]+)\]\]\s*(#.*)?$/;
const KV = /^\s*([A-Za-z0-9_.-]+|"[^"]*")\s*=\s*(.+?)\s*$/;

function splitHeaderPath(inner) {
  const parts = [];
  let cur = '', q = false;
  for (const ch of inner) {
    if (ch === '"') { q = !q; continue; }
    if (ch === '.' && !q) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}

function parseValue(raw, lineNo) {
  const s = raw.replace(/\s+#.*$/, '').trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(s)) return JSON.parse(s);
  if (/^'[^']*'$/.test(s)) return s.slice(1, -1);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    const items = [];
    let cur = '', q = false;
    for (const ch of inner) {
      if (ch === '"') q = !q;
      if (ch === ',' && !q) { items.push(cur); cur = ''; continue; }
      cur += ch;
    }
    items.push(cur);
    return items.map(i => i.trim()).filter(Boolean).map(i => parseValue(i, lineNo));
  }
  return undefined;
}

export function listTables(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    const a = ARRAY_HEADER.exec(line);
    if (a) { out.push({ path: splitHeaderPath(a[1]), line: i + 1, array: true }); return; }
    const m = HEADER.exec(line);
    if (m) out.push({ path: splitHeaderPath(m[1]), line: i + 1 });
  });
  return out;
}

export function parseToml(text, warnings = []) {
  const root = {};
  let cur = root;
  let skipArray = false;
  text.split('\n').forEach((line, i) => {
    const n = i + 1;
    const t = line.trim();
    if (t === '' || t.startsWith('#')) return;
    const a = ARRAY_HEADER.exec(line);
    if (a) { skipArray = true; warnings.push({ line: n, text: 'array of tables skipped' }); return; }
    const h = HEADER.exec(line);
    if (h) {
      skipArray = false;
      cur = root;
      for (const p of splitHeaderPath(h[1])) cur = (cur[p] ??= {});
      return;
    }
    if (skipArray) return;
    const kv = KV.exec(line);
    if (!kv) { warnings.push({ line: n, text: line }); return; }
    const key = kv[1].startsWith('"') ? kv[1].slice(1, -1) : kv[1];
    const value = parseValue(kv[2], n);
    if (value === undefined) { warnings.push({ line: n, text: line }); return; }
    cur[key] = value;
  });
  return root;
}

function isChild(path, parent) {
  return path.length >= parent.length && parent.every((p, i) => p === path[i]);
}

export function removeTable(text, tablePath) {
  const lines = text.split('\n');
  const tables = listTables(text);
  const start = tables.find(t => t.path.length === tablePath.length && isChild(t.path, tablePath));
  if (!start) return text;
  const next = tables.find(t => t.line > start.line && !isChild(t.path, tablePath));
  const from = start.line - 1;
  const to = next ? next.line - 1 : lines.length;
  const result = [...lines.slice(0, from), ...lines.slice(to)].join('\n');
  return text.endsWith('\n') && result !== '' && !result.endsWith('\n') ? result + '\n' : result;
}
