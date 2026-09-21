// tests/helpers/fixture.mjs
import fs from 'node:fs';
import path from 'node:path';

const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const skill = (dir, name, desc) => w(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n`);
const agent = (file, name, desc) => w(file, `---\nname: ${name}\ndescription: ${desc}\ntools: Read\n---\nbody\n`);
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400e3).toISOString();
const touch = (p, daysAgo) => { const d = new Date(Date.now() - daysAgo * 86400e3); fs.utimesSync(p, d, d); };

export function buildFixture(tmpDir) {
  const home = path.join(tmpDir, 'home');
  const claudeRoot = path.join(home, '.claude');
  const codexRoot = path.join(home, '.codex');
  const claudeJson = path.join(home, '.claude.json');
  const cwd = path.join(tmpDir, 'proj');
  fs.mkdirSync(cwd, { recursive: true });

  // --- Claude Code ---
  const cache = path.join(claudeRoot, 'plugins', 'cache', 'mk');
  const alpha = path.join(cache, 'alpha', 'v1');
  const beta = path.join(cache, 'beta', 'v1');
  w(path.join(alpha, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'alpha', description: 'Alpha plugin', version: '1.0.0' }));
  skill(path.join(alpha, 'skills'), 'brainstorming', 'Explore requirements before building. Use before any creative work.');
  skill(path.join(alpha, 'skills'), 'debugging', 'Find root cause of bugs. Use on any bug or test failure.');
  skill(path.join(alpha, 'skills'), 'review', 'Review a diff for bugs.');
  agent(path.join(alpha, 'agents', 'explorer.md'), 'explorer', 'Read-only explorer.');
  w(path.join(alpha, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo alpha-start' }] }] } }));
  w(path.join(alpha, '.mcp.json'), JSON.stringify({ mcpServers: { ctx: { type: 'http', url: 'https://ctx.example/mcp' } } }));
  w(path.join(beta, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'beta', description: 'Beta plugin', version: '1.0.0' }));
  skill(path.join(beta, 'skills'), 'one', 'Beta skill one.');
  w(path.join(cache, 'alpha', 'v0', '.orphaned_at'), iso(10));
  w(path.join(cache, 'alpha', 'v0', 'README.md'), 'old');
  w(path.join(claudeRoot, 'plugins', 'cache', 'temp_git_123', 'x.txt'), 'tmp');
  w(path.join(claudeRoot, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      'alpha@mk': [{ scope: 'user', installPath: alpha, version: 'v1', installedAt: iso(20), lastUpdated: iso(1) }],
      'beta@mk': [{ scope: 'user', installPath: beta, version: 'v1', installedAt: iso(20), lastUpdated: iso(1) }],
    },
  }));

  // synced plugin (claude.ai sync): gamma
  const syncDir = path.join(claudeRoot, 'plugins', 'synced', 'sync-1');
  const gamma = path.join(syncDir, 'gamma');
  w(path.join(gamma, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'gamma', description: 'Gamma plugin', version: '0001' }));
  skill(path.join(gamma, 'skills'), 'sales', 'Draft sales emails.');
  skill(path.join(gamma, 'skills'), 'invoice', 'Chase unpaid invoices.');
  w(path.join(gamma, '.mcp.json'), JSON.stringify({ mcpServers: { crm: { type: 'http', url: 'https://crm.example/mcp' } } }));
  w(path.join(syncDir, 'manifest.json'), JSON.stringify({
    lastUpdated: Date.now(),
    plugins: [{ pluginId: 'gamma-id', name: 'gamma', description: 'Gamma plugin', version: '0001', updatedAt: iso(1), marketplaceName: 'knowledge-work-plugins', installationPreference: 'available' }],
  }));

  w(path.join(claudeRoot, 'settings.json'), JSON.stringify({
    enabledPlugins: { 'alpha@mk': true, 'beta@mk': false },
    hooks: {
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node guard1.js' }, { type: 'command', command: 'node guard2.js' }] },
        { matcher: 'Write', hooks: [{ type: 'command', command: 'node guard3.js' }] },
      ],
      PostToolUse: [{ hooks: [{ type: 'command', command: 'bash post.sh' }] }],
    },
    mcpServers: { local: { command: 'node', args: ['srv.js'] } },
  }));
  w(path.join(claudeRoot, 'settings.json.bak-1'), '{}');
  w(claudeJson, JSON.stringify({
    mcpServers: { pal: { command: 'uvx', args: ['pal-mcp'] } },
    projects: { [cwd]: { mcpServers: { projsrv: { type: 'http', url: 'https://p.example' } } } },
  }));
  skill(path.join(claudeRoot, 'skills'), 'grilling', 'Grill the user about a plan.');
  skill(path.join(claudeRoot, 'skills'), 'grill-me', 'Grill me relentlessly about an idea.');
  skill(path.join(claudeRoot, 'skills'), 'harness-audit', 'Audit the harness. Must be excluded.');
  const extSkillDir = path.join(tmpDir, 'ext-skill');
  w(path.join(extSkillDir, 'SKILL.md'), '---\nname: linked-skill\ndescription: Linked from dotfiles.\n---\n# linked-skill\n');
  fs.symlinkSync(extSkillDir, path.join(claudeRoot, 'skills', 'linked-skill'), 'dir');
  agent(path.join(claudeRoot, 'agents', 'gsd-planner.md'), 'gsd-planner', 'Creates phase plans.');
  w(path.join(claudeRoot, 'CLAUDE.md'), [
    '# Global rules', '',
    'Codex config sets `model = "gpt-5.6-terra"` and `model_reasoning_effort = "medium"`.',
    'Use the pal MCP server for second opinions and the ghost MCP server for nothing.',
    'The beta plugin handles formatting.', '',
    ...Array.from({ length: 40 }, (_, i) => `Rule ${i}: keep things lean and measured.`),
  ].join('\n'));
  w(path.join(cwd, 'CLAUDE.md'), '# Project rules\nRun tests before commit.\n');

  // transcripts: one recent, one old (outside window), one stale project dir
  const projSlug = cwd.replace(/\//g, '-');
  const tu = (name, input) => JSON.stringify({ type: 'assistant', cwd, timestamp: iso(2), message: { content: [{ type: 'tool_use', id: 't', name, input }] } });
  const recent = path.join(claudeRoot, 'projects', projSlug, 's1.jsonl');
  w(recent, [
    JSON.stringify({ type: 'user', cwd, timestamp: iso(2), message: { content: 'hi' } }),
    tu('Skill', { skill: 'alpha:brainstorming' }),
    tu('Skill', { skill: 'alpha:brainstorming' }),
    tu('Skill', { skill: 'grilling' }),
    tu('mcp__pal__chat', { prompt: 'x' }),
    tu('mcp__plugin_alpha_ctx__query', { q: 'x' }),
    tu('Agent', { subagent_type: 'Explore', prompt: 'x' }),
    tu('Bash', { command: 'ls' }),
  ].join('\n') + '\n');
  const old = path.join(claudeRoot, 'projects', projSlug, 's0.jsonl');
  w(old, [tu('Skill', { skill: 'grill-me' }), tu('Skill', { skill: 'grill-me' })].join('\n') + '\n');
  touch(old, 45);
  const stale = path.join(claudeRoot, 'projects', '-nope-gone', 's9.jsonl');
  w(stale, JSON.stringify({ type: 'user', cwd: '/nope/gone', timestamp: iso(2), message: { content: 'hi' } }) + '\n');

  // --- Codex ---
  w(path.join(codexRoot, 'config.toml'), [
    'model = "gpt-6-astra"',
    'model_reasoning_effort = "high"',
    '',
    `[projects."${cwd}"]`,
    'trust_level = "trusted"',
    '',
    '[projects."/nope/dead"]',
    'trust_level = "trusted"',
    '',
    '[mcp_servers.basic-memory]',
    'command = "uvx"',
    'args = ["basic-memory", "mcp"]',
    '',
    '[mcp_servers.pal]',
    'command = "uvx"',
    'args = ["pal-mcp"]',
    '',
    '[mcp_servers.pal.env]',
    'KEY = "v"',
    '',
  ].join('\n'));
  w(path.join(codexRoot, 'config.toml.bak-1'), 'model = "old"\n');
  skill(path.join(codexRoot, 'skills'), 'web-fetch-router', 'Pick the cheapest web fetch tool.');
  skill(path.join(codexRoot, 'skills'), 'harness-audit', 'Audit the harness. Must be excluded.');
  w(path.join(codexRoot, 'AGENTS.md'), '# Codex rules\nAlways run tests.\n');
  w(path.join(cwd, 'AGENTS.md'), '# Project codex rules\n');
  w(path.join(codexRoot, 'hooks.json'), JSON.stringify({ hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'a' }, { type: 'command', command: 'b' }, { type: 'command', command: 'c' }] }],
  } }));
  const roll = path.join(codexRoot, 'sessions', '2026', '09', '20', 'rollout-1.jsonl');
  const fc = (name) => JSON.stringify({ timestamp: iso(3), type: 'response_item', payload: { type: 'function_call', name, arguments: '{}' } });
  w(roll, [
    JSON.stringify({ timestamp: iso(3), type: 'session_meta', payload: { cwd, cli_version: '0.154.0' } }),
    fc('mcp__pal__chat'),
    fc('pal__chat'),
    fc('shell'),
    JSON.stringify({ timestamp: iso(3), type: 'response_item', payload: { type: 'function_call_output', output: `read ${codexRoot}/skills/web-fetch-router/SKILL.md ok` } }),
  ].join('\n') + '\n');

  const out = path.join(tmpDir, 'out');
  return { home, claudeRoot, codexRoot, claudeJson, out, days: 30, cwd };
}
