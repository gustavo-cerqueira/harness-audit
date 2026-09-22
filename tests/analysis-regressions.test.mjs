import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractFacts, startupCost } from '../scripts/lib/analysis.mjs';

test('text mentions remain contextual candidates, including correct negation and delegated profiles', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-analysis-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = path.join(dir, 'CLAUDE.md');
  fs.writeFileSync(p, 'For a delegated reviewer use model = "gpt-5.6-terra", effort = "medium".\nDo not enable the beta plugin.\n');
  const facts = extractFacts({ instructionFiles: [{ path: p }], mcpServers: [], plugins: [{ name: 'beta', enabled: false }] }, { instructionFiles: [], mcpServers: [], config: { model: 'gpt-6-astra', effort: 'high' } });
  assert.equal(facts.some(f => f.conflict), false);
  assert.deepEqual(facts.filter(f => f.candidate).map(f => f.key), ['codex.model', 'codex.effort', 'plugin.disabled-but-mentioned']);
  const mention = facts.find(f => f.key === 'plugin.disabled-but-mentioned').mentions[0];
  assert.equal(mention.context, 'Do not enable the beta plugin.');
  assert.equal(mention.harness, 'claude');
});

test('startup estimate includes complete descriptions and paths, excludes unknown loading state', () => {
  const s = { id: 'long', description: 'x'.repeat(400), path: '/skills/long/SKILL.md', loaded: true };
  const cost = startupCost({ skills: [s, { ...s, loaded: null }], agents: [], hooks: {}, instructionFiles: [] }, null).claude;
  assert.equal(cost.skillList, Math.ceil((s.id.length + s.description.length + s.path.length + 6) / 4));
  assert.match(cost.basis, /Not a measured session prompt/);
});
