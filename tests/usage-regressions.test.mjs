import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { usageClaude, usageCodex } from '../scripts/lib/usage.mjs';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ha-usage-'));
const event = (timestamp, payload) => JSON.stringify({ timestamp, type: 'response_item', payload });

test('usage ignores old and untimestamped events in a recently changed transcript', async () => {
  const root = dir();
  const file = path.join(root, 'session.jsonl');
  const since = Date.now() - 86_400_000;
  const old = new Date(since - 1).toISOString();
  const recent = new Date(since + 1).toISOString();
  fs.writeFileSync(file, [
    JSON.stringify({ timestamp: old, message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'old' } }] } }),
    JSON.stringify({ timestamp: recent, message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'recent' } }] } }),
    JSON.stringify({ message: { content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'unknown-time' } }] } }),
  ].join('\n'));

  const usage = await usageClaude(root, since);

  assert.equal(usage.sessions, 1);
  assert.deepEqual(usage.skills, { recent: 1 });
  assert.equal(usage.skipped.missingTimestamp, 1);
});

test('usageCodex counts only known skills read through a tool input', async () => {
  const root = dir();
  const skillPath = path.join(root, 'skills', 'known', 'SKILL.md');
  const file = path.join(root, 'session.jsonl');
  const now = new Date().toISOString();
  fs.writeFileSync(file, [
    event(now, { type: 'message', content: [{ text: `catalog: ${skillPath}` }] }),
    event(now, { type: 'function_call_output', output: `read ${skillPath}` }),
    event(now, { type: 'custom_tool_call', name: 'exec', input: `const catalog = '${skillPath}'` }),
    event(now, { type: 'function_call', name: 'shell', arguments: JSON.stringify({ cmd: `echo 'cat ${skillPath}'` }) }),
    event(now, { type: 'function_call', name: 'shell', arguments: JSON.stringify({ cmd: `cat /tmp/other; echo ${skillPath}` }) }),
    event(now, { type: 'function_call', name: 'shell', arguments: JSON.stringify({ cmd: `cat ${skillPath}.backup` }) }),
    event(now, { type: 'function_call', name: 'spawn_agent', arguments: JSON.stringify({ agent_type: 'terra_medium', prompt: `cat ${skillPath}` }) }),
    event(now, { type: 'custom_tool_call', name: 'exec', input: `const example = "await tools.exec_command({ cmd: 'cat ${skillPath}' })"` }),
    event(now, { type: 'custom_tool_call', name: 'exec', input: `await tools.exec_command({ cmd: 'sed -n 1,20 ${skillPath}' })` }),
  ].join('\n'));

  const usage = await usageCodex(root, Date.now() - 60_000, { skills: [{ id: 'known', name: 'known', path: skillPath }] });

  assert.deepEqual(usage.skills, { known: 1 });
  assert.equal(usage.coverage.skills.status, 'partial');
});

test('usageClaude downgrades MCP coverage when a tool cannot be mapped', async () => {
  const root = dir();
  const file = path.join(root, 'session.jsonl');
  const now = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify({ timestamp: now, message: { content: [{ type: 'tool_use', name: 'mcp__ghost__ask', input: {} }] } }));

  const usage = await usageClaude(root, Date.now() - 60_000, { mcpServers: [{ name: 'known', source: 'config.toml' }] });

  assert.deepEqual(usage.mcpServers, {});
  assert.deepEqual(usage.unknown.mcpServers.unmapped, { mcp__ghost__ask: 1 });
  assert.equal(usage.coverage.mcpServers.status, 'partial');
});

test('usageCodex accepts an exact quoted read path before a shell comment', async () => {
  const root = dir();
  const skillPath = path.join(root, 'skills', 'known', 'SKILL.md');
  const file = path.join(root, 'session.jsonl');
  fs.writeFileSync(file, event(new Date().toISOString(), { type: 'function_call', name: 'shell', arguments: JSON.stringify({ cmd: `cat "${skillPath}" # inspect skill` }) }));

  const usage = await usageCodex(root, Date.now() - 60_000, { skills: [{ id: 'known', name: 'known', path: skillPath }] });

  assert.deepEqual(usage.skills, { known: 1 });
});

test('usageCodex leaves duplicated skill identities unknown instead of crediting both', async () => {
  const root = dir();
  const skillPath = path.join(root, 'skills', 'same', 'SKILL.md');
  const file = path.join(root, 'session.jsonl');
  fs.writeFileSync(file, event(new Date().toISOString(), { type: 'function_call', name: 'shell', arguments: JSON.stringify({ cmd: `cat ${skillPath}` }) }));

  const usage = await usageCodex(root, Date.now() - 60_000, { skills: [
    { id: 'one', name: 'one', path: skillPath },
    { id: 'two', name: 'two', path: skillPath },
  ] });

  assert.deepEqual(usage.skills, {});
  assert.deepEqual(usage.unknown.skills, { [skillPath]: 1 });
});

test('usageCodex records delegation by agent_type without treating unrecorded agent types as zero', async () => {
  const root = dir();
  const file = path.join(root, 'session.jsonl');
  const now = new Date().toISOString();
  fs.writeFileSync(file, event(now, { type: 'function_call', name: 'spawn_agent', arguments: '{"agent_type":"terra_medium"}' }));

  const usage = await usageCodex(root, Date.now() - 60_000, { agents: [{ id: 'terra_medium', name: 'terra_medium' }] });

  assert.deepEqual(usage.agents, { terra_medium: 1 });
  assert.equal(usage.coverage.agents.status, 'partial');
  assert.equal(usage.coverage.hooks.status, 'unknown');
});

test('usageCodex leaves agent coverage unknown when no spawn_agent event is recorded', async () => {
  const root = dir();
  const file = path.join(root, 'session.jsonl');
  const now = new Date().toISOString();
  fs.writeFileSync(file, [
    event(now, { type: 'function_call', name: 'shell', arguments: '{}' }),
    event(now, { type: 'custom_tool_call', name: 'exec', input: 'const prompt = "tools.spawn_agent({ agent_type: \'terra_medium\' })"' }),
  ].join('\n'));

  const usage = await usageCodex(root, Date.now() - 60_000, { agents: [{ id: 'terra_medium', name: 'terra_medium' }] });

  assert.deepEqual(usage.agents, {});
  assert.equal(usage.coverage.agents.status, 'unknown');
});

test('usageCodex maps MCP tools from source-qualified server metadata without truncating underscores', async () => {
  const root = dir();
  const file = path.join(root, 'session.jsonl');
  const now = new Date().toISOString();
  const call = (name, timestamp = now) => event(timestamp, { type: 'function_call', name, arguments: '{}' });
  fs.writeFileSync(file, [
    call('mcp__plugin_alpha_ctx__query'),
    call('mcp__plugin_team_plugin_team_server__search'),
    call('mcp__team_server__search'),
    call('mcp__ctx__ambiguous'),
    call('mcp__ghost__ask'),
    call('mcp__plugin_team_plugin_team_server__old', new Date(Date.now() - 120_000).toISOString()),
    call('mcp__team_server__future', new Date(Date.now() + 60_000).toISOString()),
  ].join('\n'));

  const usage = await usageCodex(root, Date.now() - 60_000, { mcpServers: [
    { name: 'ctx', source: 'plugin:alpha' },
    { name: 'ctx', source: 'plugin:beta' },
    { name: 'team_server', source: 'plugin:team_plugin' },
    { name: 'team_server', source: 'config.toml' },
  ] });

  assert.deepEqual(usage.mcpServers, { ctx: 1, team_server: 1 });
  assert.deepEqual(usage.unknown.mcpServers.ambiguous, { mcp__ctx__ambiguous: 1, mcp__team_server__search: 1 });
  assert.deepEqual(usage.unknown.mcpServers.unmapped, { mcp__ghost__ask: 1 });
  assert.equal(usage.skipped.futureTimestamp, 1);
  assert.equal(usage.coverage.mcpServers.status, 'partial');
});
