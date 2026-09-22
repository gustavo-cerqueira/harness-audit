import { filesNewerThan, scanJsonl } from './jsonl.mjs';

const bump = (map, key) => { if (key) map[key] = (map[key] ?? 0) + 1; };
const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function usageBase(coverage) {
  return {
    sessions: 0, skills: {}, agents: {}, mcpTools: {}, mcpServers: {}, tools: {},
    unknown: { skills: {}, agents: {}, mcpServers: { unmapped: {}, ambiguous: {} } },
    skipped: { missingTimestamp: 0, futureTimestamp: 0 }, coverage, warnings: [],
  };
}

function timestampMs(obj) {
  const value = obj?.timestamp;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function inputValue(payload) {
  const value = payload?.input ?? payload?.arguments;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function inputText(payload) {
  const value = payload?.input ?? payload?.arguments;
  return typeof value === 'string' ? value : value && typeof value === 'object' ? JSON.stringify(value) : '';
}

function inventory(value) {
  if (Array.isArray(value)) return {
    skills: [], agents: [], mcpServers: value.map(name => ({ name, source: null })), supplied: false,
    skillsSupplied: false, agentsSupplied: false, serversSupplied: true,
  };
  const supplied = value && typeof value === 'object';
  return {
    skills: Array.isArray(value?.skills) ? value.skills : [],
    agents: Array.isArray(value?.agents) ? value.agents : [],
    mcpServers: Array.isArray(value?.mcpServers) ? value.mcpServers : [],
    supplied,
    skillsSupplied: supplied && has(value, 'skills'),
    agentsSupplied: supplied && has(value, 'agents'),
    serversSupplied: supplied && has(value, 'mcpServers'),
  };
}

function serverMatch(name, servers) {
  const candidates = [];
  for (const server of servers) {
    if (!server?.name) continue;
    const prefixes = [`mcp__${server.name}__`, `${server.name}__`];
    if (typeof server.source === 'string' && server.source.startsWith('plugin:')) {
      const plugin = server.source.slice('plugin:'.length).replace(/-/g, '_');
      prefixes.push(`mcp__plugin_${plugin}_${server.name}__`);
    }
    if (prefixes.some(prefix => name.startsWith(prefix))) candidates.push(server);
  }
  return candidates;
}

function noteMcp(u, name, servers) {
  const matches = serverMatch(name, servers);
  if (matches.length === 1) {
    bump(u.mcpTools, name);
    bump(u.mcpServers, matches[0].name);
  } else if (matches.length > 1) bump(u.unknown.mcpServers.ambiguous, name);
  else if (name.startsWith('mcp__') || /^[A-Za-z0-9][A-Za-z0-9_-]*__/.test(name)) bump(u.unknown.mcpServers.unmapped, name);
}

function isCodexCall(payload) {
  return (payload?.type === 'function_call' || payload?.type === 'custom_tool_call') && typeof payload.name === 'string';
}

function shellTokens(command) {
  const tokens = [];
  let token = '', quote = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === '\\' && i + 1 < command.length) token += command[++i];
      else if (char === quote) quote = null;
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char)) { if (token) { tokens.push(token); token = ''; } continue; }
    if (char === '#' && !token) break;
    if (';&|`$()<>'.includes(char)) return null;
    token += char;
  }
  if (quote) return null;
  if (token) tokens.push(token);
  return tokens;
}

function shellReadPaths(command) {
  const tokens = shellTokens(command);
  if (!tokens || !['cat', 'sed', 'head', 'tail', 'less', 'awk'].includes(tokens[0])) return [];
  return tokens.slice(1);
}

function wrapperCommand(payload) {
  if (!/^(exec|functions\.exec)$/i.test(payload.name)) return '';
  // Accept only a literal wrapper call at a statement or assignment boundary.
  // This intentionally ignores quoted examples and dynamically-built commands.
  const match = inputText(payload).match(/(?:^|[;\n]|=\s*)(?:await\s+)?tools\.exec_command\s*\(\s*\{\s*["']?cmd["']?\s*:\s*(["'])([\s\S]*?)\1/);
  return match?.[2] ?? '';
}

function readSkillPaths(payload, skills) {
  const name = payload.name.toLowerCase();
  let paths;
  if (/^(read|read_file|open)$/i.test(name)) {
    const input = inputValue(payload);
    paths = typeof input === 'object' && input ? [input.path] : [input];
  } else {
    const input = inputValue(payload);
    const command = /^(shell|exec_command|bash)$/i.test(name)
      ? (typeof input === 'string' ? input : input?.cmd ?? input?.command ?? '')
      : wrapperCommand(payload);
    paths = typeof command === 'string' ? shellReadPaths(command) : [];
  }
  if (!paths?.length) return [];
  const byPath = new Map();
  for (const requestedPath of paths) {
    if (typeof requestedPath !== 'string') continue;
    const matches = skills.filter(skill => skill?.path === requestedPath);
    if (matches.length) byPath.set(requestedPath, matches);
  }
  return [...byPath.values()];
}

function delegatedAgent(payload) {
  if (/^(spawn_agent|collaboration\.spawn_agent)$/.test(payload.name)) {
    const input = inputValue(payload);
    return typeof input === 'object' && input ? input.agent_type : null;
  }
  // `exec` is the current Codex wrapper. Only accept a literal spawn_agent call,
  // never a mention in instructions or tool output.
  if (!/^(exec|functions\.exec)$/.test(payload.name)) return null;
  const match = inputText(payload).match(/(?:^|[;\n]|=\s*)(?:await\s+)?tools\.spawn_agent\s*\(\s*\{[\s\S]{0,200}?agent_type\s*:\s*["']([^"']+)["']/);
  return match?.[1] ?? null;
}

export async function usageClaude(projectsDir, sinceMs, known = {}) {
  const inv = inventory(known);
  const nowMs = Date.now();
  const u = usageBase({
    skills: { status: 'measured', method: 'Skill tool calls' },
    agents: { status: 'measured', method: 'Agent tool calls' },
    mcpServers: { status: inv.serversSupplied ? 'measured' : 'unknown', method: 'source-qualified MCP tool names' },
    hooks: { status: 'unknown', reason: 'hook executions are not represented in transcripts' },
  });
  for (const file of filesNewerThan(projectsDir, sinceMs, '.jsonl')) {
    let sessionInWindow = false;
    try {
      await scanJsonl(file, '', obj => {
        const eventMs = timestampMs(obj);
        if (eventMs != null && eventMs >= sinceMs && eventMs <= nowMs) sessionInWindow = true;
        const content = obj?.message?.content;
        if (!Array.isArray(content)) return;
        const blocks = content.filter(block => block?.type === 'tool_use');
        if (!blocks.length) return;
        if (eventMs == null) { u.skipped.missingTimestamp += blocks.length; return; }
        if (eventMs < sinceMs) return;
        if (eventMs > nowMs) { u.skipped.futureTimestamp += blocks.length; return; }
        for (const block of blocks) {
          bump(u.tools, block.name);
          if (block.name === 'Skill') bump(u.skills, block.input?.skill);
          else if (block.name === 'Agent') bump(u.agents, block.input?.subagent_type);
          else if (typeof block.name === 'string' && block.name.startsWith('mcp__')) noteMcp(u, block.name, inv.mcpServers);
        }
      });
    } catch (e) { u.warnings.push({ path: file, message: `read: ${e.message}` }); }
    if (sessionInWindow) u.sessions++;
  }
  if (u.skipped.missingTimestamp || u.skipped.futureTimestamp) {
    for (const area of ['skills', 'agents', 'mcpServers']) if (u.coverage[area].status === 'measured') u.coverage[area].status = 'partial';
  }
  if ((Object.keys(u.unknown.mcpServers.unmapped).length || Object.keys(u.unknown.mcpServers.ambiguous).length)
    && u.coverage.mcpServers.status === 'measured') u.coverage.mcpServers.status = 'partial';
  return u;
}

export async function usageCodex(sessionsDir, sinceMs, known = {}) {
  const inv = inventory(known);
  const nowMs = Date.now();
  const u = usageBase({
    skills: inv.skillsSupplied
      ? { status: 'partial', method: 'known SKILL.md paths in tool inputs' }
      : { status: 'unknown', reason: 'skill inventory was not supplied' },
    agents: { status: 'unknown', reason: 'only explicit spawn_agent agent_type calls are identifiable' },
    mcpServers: { status: inv.serversSupplied ? 'partial' : 'unknown', method: 'source-qualified MCP tool names' },
    hooks: { status: 'unknown', reason: 'hook executions are not represented in transcripts' },
  });
  let sawDelegation = false;
  for (const file of filesNewerThan(sessionsDir, sinceMs, '.jsonl')) {
    let sessionInWindow = false;
    try {
      await scanJsonl(file, '', obj => {
        const eventMs = timestampMs(obj);
        if (eventMs != null && eventMs >= sinceMs && eventMs <= nowMs) sessionInWindow = true;
        const payload = obj?.payload;
        if (!isCodexCall(payload)) return;
        if (eventMs == null) { u.skipped.missingTimestamp++; return; }
        if (eventMs < sinceMs) return;
        if (eventMs > nowMs) { u.skipped.futureTimestamp++; return; }
        bump(u.tools, payload.name);
        noteMcp(u, payload.name, inv.mcpServers);
        if (inv.skillsSupplied) for (const matches of readSkillPaths(payload, inv.skills)) {
          if (matches.length === 1) bump(u.skills, matches[0].id ?? matches[0].name);
          else bump(u.unknown.skills, matches[0].path);
        }
        const agent = delegatedAgent(payload);
        if (agent) {
          sawDelegation = true;
          const knownAgent = inv.agents.find(item => item?.id === agent || item?.name === agent);
          if (knownAgent) bump(u.agents, knownAgent.id ?? knownAgent.name);
          else bump(u.unknown.agents, agent);
        }
      });
    } catch (e) { u.warnings.push({ path: file, message: `read: ${e.message}` }); }
    if (sessionInWindow) u.sessions++;
  }
  if (sawDelegation) u.coverage.agents.status = 'partial';
  if (u.skipped.missingTimestamp || u.skipped.futureTimestamp) {
    for (const area of ['skills', 'mcpServers']) if (u.coverage[area].status === 'measured') u.coverage[area].status = 'partial';
  }
  return u;
}
