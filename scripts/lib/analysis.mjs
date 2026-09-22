// scripts/lib/analysis.mjs
import fs from 'node:fs';

const t = n => Math.ceil(n / 4);
const hookCount = h => Object.values(h ?? {}).reduce((n, arr) => n + arr.length, 0);

function costFor(section) {
  if (!section) return null;
  const metadataTokens = item => t(item.id.length + item.description.length + (item.path?.length ?? 0) + 6);
  const skillList = section.skills.filter(s => s.loaded === true).reduce((n, s) => n + metadataTokens(s), 0);
  const agentList = section.agents.filter(a => a.loaded === true).reduce((n, a) => n + metadataTokens(a), 0);
  const instructionFiles = section.instructionFiles.reduce((n, f) => n + f.tokensEst, 0);
  return { skillList, agentList, mcpToolNames: null, instructionFiles, hooks: hookCount(section.hooks), total: skillList + agentList + instructionFiles,
    basis: 'Discovered enabled metadata and instruction text, characters / 4; excludes tool schemas, runtime injections and unknown scopes. Not a measured session prompt.' };
}

export function startupCost(claude, codex) {
  return { claude: costFor(claude), codex: costFor(codex) };
}

function scanFiles(files, regex, pick) {
  const out = [];
  for (const f of files) {
    const lines = fs.readFileSync(f.path, 'utf8').split('\n');
    lines.forEach((line, i) => { for (const m of line.matchAll(regex)) { const value = pick(m); if (value) out.push({ file: f.path, line: i + 1, value, context: line.trim(), harness: f.harness }); } });
  }
  return out;
}

export function extractFacts(claude, codex) {
  const claudeFiles = (claude?.instructionFiles ?? []).map(f => ({ ...f, harness: 'claude' }));
  const codexFiles = (codex?.instructionFiles ?? []).map(f => ({ ...f, harness: 'codex' }));
  const files = [...claudeFiles, ...codexFiles];
  const facts = [];
  // Text matches need contextual judgement: examples, negation and delegated profiles are not conflicts.
  const candidate = (key, config, mentions) => facts.push({ key, config, mentions, candidate: mentions.length > 0, conflict: false });
  if (codex) {
    const modelRe = /model\s*[=:]\s*["'`]?((?:gpt|claude|o[1-9])[a-z0-9.-]*)/gi;
    const isCodexModel = v => /^(gpt-|o[1-9])/.test(v);
    const mentions = scanFiles(files, modelRe, m => m[1])
      .filter(m => isCodexModel(m.value))
      .filter(m => codex.config.model != null && m.value !== codex.config.model);
    candidate('codex.model', codex.config.model, mentions);
    const effRe = /(?:model_reasoning_effort|reasoning_effort|effort)\s*[=:]\s*["'`]?([a-z]+)/gi;
    const eff = scanFiles(files, effRe, m => m[1]).filter(m => codex.config.effort != null && m.value !== codex.config.effort);
    candidate('codex.effort', codex.config.effort, eff);
  }
  const servers = new Set([...(claude?.mcpServers ?? []), ...(codex?.mcpServers ?? [])].map(s => s.name));
  const srvRe = /\b([a-z0-9][a-z0-9-]*)\s+mcp\s+server\b|\bmcp\s+server\s+(?:named\s+|called\s+)?([a-z0-9][a-z0-9-]*)/gi;
  const byHarness = { claude: new Set((claude?.mcpServers ?? []).map(s => s.name)), codex: new Set((codex?.mcpServers ?? []).map(s => s.name)) };
  const unknown = scanFiles(files, srvRe, m => (m[1] ?? m[2]).toLowerCase()).filter(m => !byHarness[m.harness].has(m.value) && !['the', 'a', 'an', 'this', 'that', 'each', 'every', 'any', 'no', 'one'].includes(m.value));
  candidate('mcp.unknown-server', [...servers].sort(), unknown);
  if (claude) {
    const disabled = new Set(claude.plugins.filter(p => !p.enabled).map(p => p.name));
    const plgRe = /\b([a-z0-9][a-z0-9-]*)\s+plugin\b/gi;
    const dm = scanFiles(claudeFiles, plgRe, m => m[1].toLowerCase()).filter(m => disabled.has(m.value));
    candidate('plugin.disabled-but-mentioned', claude.plugins.filter(p => p.enabled).map(p => p.name).sort(), dm);
  }
  return facts;
}
