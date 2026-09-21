// scripts/lib/usage.mjs
import { filesNewerThan, scanJsonl } from './jsonl.mjs';

const bump = (map, key) => { if (key) map[key] = (map[key] ?? 0) + 1; };

function serverOf(name, knownServers) {
  let m = /^mcp__plugin_[^_]+(?:_[^_]+)*?_([^_][^_]*?)__/.exec(name); // mcp__plugin_<plugin>_<server>__tool
  if (m) return m[1];
  m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(name);
  if (m) return m[1];
  m = /^([^_]+(?:_[^_]+)*?)__/.exec(name);
  if (m && knownServers.includes(m[1])) return m[1];
  return null;
}

export async function usageClaude(projectsDir, sinceMs) {
  const u = { sessions: 0, skills: {}, agents: {}, mcpTools: {}, mcpServers: {}, tools: {}, warnings: [] };
  for (const file of filesNewerThan(projectsDir, sinceMs, '.jsonl')) {
    u.sessions++;
    try {
      await scanJsonl(file, '"tool_use"', obj => {
        const content = obj?.message?.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (block?.type !== 'tool_use') continue;
          bump(u.tools, block.name);
          if (block.name === 'Skill') bump(u.skills, block.input?.skill);
          else if (block.name === 'Agent') bump(u.agents, block.input?.subagent_type);
          else if (typeof block.name === 'string' && block.name.startsWith('mcp__')) {
            bump(u.mcpTools, block.name);
            bump(u.mcpServers, serverOf(block.name, []));
          }
        }
      });
    } catch (e) { u.warnings.push({ path: file, message: `read: ${e.message}` }); }
  }
  return u;
}

export async function usageCodex(sessionsDir, sinceMs, knownServers = []) {
  const u = { sessions: 0, skills: {}, mcpTools: {}, mcpServers: {}, tools: {}, warnings: [] };
  for (const file of filesNewerThan(sessionsDir, sinceMs, '.jsonl')) {
    u.sessions++;
    const skillsSeen = new Set();
    try {
      await scanJsonl(file, '', obj => {
        const raw = JSON.stringify(obj);
        for (const m of raw.matchAll(/skills\/([A-Za-z0-9_.-]+)\/SKILL\.md/g)) skillsSeen.add(m[1]);
        const p = obj?.payload;
        if (!p || (p.type !== 'function_call' && p.type !== 'custom_tool_call') || typeof p.name !== 'string') return;
        bump(u.tools, p.name);
        const server = serverOf(p.name, knownServers);
        if (server) { bump(u.mcpTools, p.name); bump(u.mcpServers, server); }
      });
    } catch (e) { u.warnings.push({ path: file, message: `read: ${e.message}` }); }
    for (const s of skillsSeen) bump(u.skills, s);
  }
  return u;
}
