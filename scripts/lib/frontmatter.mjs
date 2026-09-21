// scripts/lib/frontmatter.mjs
export function readFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return { name: null, description: '', raw: {} };
  const raw = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let val = kv[2].trim();
    if (val === '>' || val === '|' || val === '>-' || val === '|-') {
      const block = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      val = block.join(' ');
    }
    raw[kv[1]] = val.replace(/^["']|["']$/g, '');
  }
  return { name: raw.name ?? null, description: raw.description ?? '', raw };
}
