// ponytail: line-based TOML subset (bare/dotted/quoted tables, scalars, flat arrays).
// Enough for ~/.codex/config.toml. Inline tables and multi-line arrays throw before edits.

const KV = /^\s*([A-Za-z0-9_.-]+|"[^"]*")\s*=\s*(.+?)\s*$/;

function splitHeaderPath(inner) {
  const parts = [];
  let cur = '', quoted = false, escaped = false;
  for (const ch of inner) {
    if (quoted && escaped) { cur += ch; escaped = false; continue; }
    if (quoted && ch === '\\') { cur += ch; escaped = true; continue; }
    if (ch === '"') { quoted = !quoted; cur += ch; continue; }
    if (ch === '.' && !quoted) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (quoted) throw new Error('unterminated quoted table key');
  parts.push(cur.trim());
  return parts.map(part => {
    if (/^"(?:[^"\\]|\\.)*"$/.test(part)) return JSON.parse(part);
    if (/^[A-Za-z0-9_-]+$/.test(part)) return part;
    throw new Error(`unsupported table key: ${part}`);
  });
}

function header(line) {
  const text = line.trim();
  if (!text.startsWith('[')) return null;
  const array = text.startsWith('[[');
  const start = array ? 2 : 1;
  let quoted = false, escaped = false, end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quoted && escaped) { escaped = false; continue; }
    if (quoted && ch === '\\') { escaped = true; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (!quoted && ch === ']') {
      if (array && text[i + 1] !== ']') return { invalid: true };
      end = i;
      break;
    }
  }
  if (end < 0 || quoted) return { invalid: true };
  const tail = text.slice(end + (array ? 2 : 1)).trim();
  if (tail && !tail.startsWith('#')) return { invalid: true };
  try {
    return { path: splitHeaderPath(text.slice(start, end)), array };
  } catch {
    return { invalid: true };
  }
}

function parseValue(raw) {
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
    let cur = '', quoted = false, escaped = false;
    for (const ch of inner) {
      if (quoted && escaped) { cur += ch; escaped = false; continue; }
      if (quoted && ch === '\\') { cur += ch; escaped = true; continue; }
      if (ch === '"') quoted = !quoted;
      if (ch === ',' && !quoted) { items.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (quoted) return undefined;
    items.push(cur);
    return items.map(i => i.trim()).filter(Boolean).map(parseValue).every(v => v !== undefined)
      ? items.map(i => parseValue(i.trim()))
      : undefined;
  }
  return undefined;
}

export function listTables(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    const h = header(line);
    if (h && !h.invalid) out.push({ path: h.path, line: i + 1, array: h.array || undefined });
  });
  return out;
}

export function parseToml(text, warnings = []) {
  const root = Object.create(null);
  let cur = root;
  let skipArray = false;
  text.split('\n').forEach((line, i) => {
    const n = i + 1;
    const t = line.trim();
    if (t === '' || t.startsWith('#')) return;
    const h = header(line);
    if (h?.invalid) { warnings.push({ line: n, text: line }); return; }
    if (h?.array) { skipArray = true; warnings.push({ line: n, text: 'array of tables skipped' }); return; }
    if (h) {
      skipArray = false;
      cur = root;
      for (const p of h.path) cur = (cur[p] ??= Object.create(null));
      return;
    }
    if (skipArray) return;
    const kv = KV.exec(line);
    if (!kv) { warnings.push({ line: n, text: line }); return; }
    const key = kv[1].startsWith('"') ? kv[1].slice(1, -1) : kv[1];
    const value = parseValue(kv[2]);
    if (value === undefined) { warnings.push({ line: n, text: line }); return; }
    cur[key] = value;
  });
  return root;
}

export function assertSupportedToml(text) {
  const warnings = [];
  parseToml(text, warnings);
  if (warnings.length) throw new Error(`unsupported TOML at line ${warnings[0].line}: ${warnings[0].text.trim()}`);
}

function isChild(path, parent) {
  return path.length >= parent.length && parent.every((p, i) => p === path[i]);
}

export function removeTable(text, tablePath) {
  const lines = text.split('\n');
  const tables = listTables(text);
  const drops = [];
  for (let i = 0; i < tables.length; i++) {
    if (!isChild(tables[i].path, tablePath)) continue;
    let from = tables[i].line - 1;
    if (from > 0 && lines[from - 1] === '') from--;
    const to = i + 1 < tables.length ? tables[i + 1].line - 1 : lines.length;
    drops.push([from, to]);
  }
  if (!drops.length) return text;
  const result = lines.filter((_, i) => !drops.some(([from, to]) => i >= from && i < to)).join('\n');
  return text.endsWith('\n') && result && !result.endsWith('\n') ? result + '\n' : result;
}
