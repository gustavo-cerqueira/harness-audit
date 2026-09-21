// scripts/lib/analysis.mjs
import fs from 'node:fs';

const t = n => Math.ceil(n / 4);
const hookCount = h => Object.values(h ?? {}).reduce((n, arr) => n + arr.length, 0);

function costFor(section) {
  if (!section) return null;
  const skillList = section.skills.filter(s => s.loaded).reduce((n, s) => n + t(s.id.length + Math.min(s.description.length, 300) + 6), 0);
  const agentList = section.agents.filter(a => a.loaded).reduce((n, a) => n + t(a.id.length + a.description.length + 6), 0);
  const instructionFiles = section.instructionFiles.reduce((n, f) => n + f.tokensEst, 0);
  return { skillList, agentList, mcpToolNames: null, instructionFiles, hooks: hookCount(section.hooks), total: skillList + agentList + instructionFiles };
}

export function startupCost(claude, codex) {
  return { claude: costFor(claude), codex: costFor(codex) };
}

function scanFiles(files, regex, pick) {
  const out = [];
  for (const f of files) {
    const lines = fs.readFileSync(f.path, 'utf8').split('\n');
    lines.forEach((line, i) => { for (const m of line.matchAll(regex)) { const value = pick(m); if (value) out.push({ file: f.path, line: i + 1, value }); } });
  }
  return out;
}

export function extractFacts(claude, codex) {
  const files = [...(claude?.instructionFiles ?? []), ...(codex?.instructionFiles ?? [])];
  const facts = [];
  if (codex) {
    const modelRe = /model\s*[=:]\s*["'`]?((?:gpt|claude|o[1-9])[a-z0-9.-]*)/gi;
    const isCodexModel = v => /^(gpt-|o[1-9])/.test(v);
    const mentions = scanFiles(files, modelRe, m => m[1])
      .filter(m => isCodexModel(m.value))
      .filter(m => codex.config.model != null && m.value !== codex.config.model);
    facts.push({ key: 'codex.model', config: codex.config.model, mentions, conflict: mentions.length > 0 });
    const effRe = /(?:model_reasoning_effort|reasoning_effort|effort)\s*[=:]\s*["'`]?([a-z]+)/gi;
    const eff = scanFiles(files, effRe, m => m[1]).filter(m => codex.config.effort != null && m.value !== codex.config.effort);
    facts.push({ key: 'codex.effort', config: codex.config.effort, mentions: eff, conflict: eff.length > 0 });
  }
  const servers = new Set([...(claude?.mcpServers ?? []), ...(codex?.mcpServers ?? [])].map(s => s.name));
  const srvRe = /\b([a-z0-9][a-z0-9-]*)\s+mcp\s+server\b|\bmcp\s+server\s+(?:named\s+|called\s+)?([a-z0-9][a-z0-9-]*)/gi;
  const unknown = scanFiles(files, srvRe, m => (m[1] ?? m[2]).toLowerCase()).filter(m => !servers.has(m.value) && !['the', 'a', 'an', 'this', 'that', 'each', 'every', 'any', 'no', 'one'].includes(m.value));
  facts.push({ key: 'mcp.unknown-server', config: [...servers].sort(), mentions: unknown, conflict: unknown.length > 0 });
  if (claude) {
    const disabled = new Set(claude.plugins.filter(p => !p.enabled).map(p => p.name));
    const plgRe = /\b([a-z0-9][a-z0-9-]*)\s+plugin\b/gi;
    const dm = scanFiles(files, plgRe, m => m[1].toLowerCase()).filter(m => disabled.has(m.value));
    facts.push({ key: 'plugin.disabled-but-mentioned', config: claude.plugins.filter(p => p.enabled).map(p => p.name).sort(), mentions: dm, conflict: dm.length > 0 });
  }
  return facts;
}
