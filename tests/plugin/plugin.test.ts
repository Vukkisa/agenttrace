import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const PLUGIN = join(ROOT, 'plugins/agenttrace');
const SKILL_FILE = join(PLUGIN, 'skills/agenttrace/SKILL.md');
const INSTALLER = join(ROOT, 'scripts/install-skill.sh');
const TOOLS = ['list_sessions', 'analyze_session', 'get_failures', 'cost_summary'];

const skill = readFileSync(SKILL_FILE, 'utf8');
const fm = /^---\n([\s\S]*?)\n---\n/.exec(skill);
const frontmatter = fm ? fm[1] : '';
const body = fm ? skill.slice(fm[0].length) : skill;
const field = (name: string) => new RegExp(`^${name}:\\s*(.*)$`, 'm').exec(frontmatter)?.[1].trim().replace(/^"|"$/g, '');
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const pkg = readJson(join(ROOT, 'package.json'));

describe('skill frontmatter and structure', () => {
  it('has the expected frontmatter', () => {
    expect(fm).not.toBeNull();
    expect(field('name')).toBe('agenttrace');
    expect(field('description')).toMatch(/AgentTrace/);
    expect(field('argument-hint')).toMatch(/latest.*sessions.*failures.*costs.*weekly/);
    expect(field('disable-model-invocation')).toBe('true');
  });

  it('pre-approves exactly the four tools under both naming schemes', () => {
    const allowed = (field('allowed-tools') ?? '').split(/\s+/).sort();
    const expected = TOOLS.flatMap(t => [`mcp__agenttrace__${t}`, `mcp__plugin_agenttrace_agenttrace__${t}`]).sort();
    expect(allowed).toEqual(expected);
  });

  it('only names tools that the MCP server really registers', () => {
    const server = readFileSync(join(ROOT, 'src/mcp/server.ts'), 'utf8');
    const registered = [...server.matchAll(/registerTool\('([a-z_]+)'/g)].map(m => m[1]).sort();
    expect(registered).toEqual([...TOOLS].sort());
  });

  it('has the seven report sections in order', () => {
    const titles = ['Session highlight', 'Usage', 'Time', 'Agent activity', 'Problems', 'What this means', 'Suggested next step'];
    let at = -1;
    for (const t of titles) {
      const i = body.indexOf(`**${t}**`);
      expect(i, t).toBeGreaterThan(at);
      at = i;
    }
  });

  it('labels long pauses Estimated and never sums tokens itself', () => {
    expect(body).toMatch(/long pauses \(Estimated/);
    expect(body).toMatch(/Never add token fields together yourself/);
  });

  it('defines Measured, Estimated and Heuristic labels', () => {
    for (const l of ['Measured', 'Estimated', 'Heuristic']) expect(body).toContain(`**${l}**`);
  });
});

describe('actions and tool mappings', () => {
  const row = (action: string) => body.split('\n').find(l => l.startsWith(`| ${action} `)) ?? '';

  it('maps each action to the right tool', () => {
    expect(row('(empty)')).toContain('analyze_session');
    expect(row('`latest`')).toContain('analyze_session');
    expect(row('`latest`')).toContain('get_failures');
    expect(row('`sessions`')).toContain('list_sessions');
    expect(row('`failures`')).toContain('get_failures');
    expect(row('`costs`')).toContain('cost_summary');
    expect(row('`costs`')).toContain('"model"');
    expect(row('`weekly`')).toContain('cost_summary');
    expect(row('`weekly`')).toContain('list_sessions');
    expect(row('`weekly`')).toContain('since');
  });

  it('passes the argument through and handles unknown actions', () => {
    expect(body).toContain('$ARGUMENTS');
    expect(body).toMatch(/other first word, list the six valid actions/);
  });

  it('says weekly per-day output has no cost', () => {
    expect(row('`weekly`')).toMatch(/per-day output has tokens only/);
  });
});

describe('missing MCP connection', () => {
  it('explains how to reconnect and stops', () => {
    expect(body).toMatch(/If the tools are missing/);
    expect(body).toContain('/mcp');
    expect(body).toContain('claude mcp add agenttrace --scope user -- npx -y @vukkisa/agenttrace mcp');
    expect(body).toMatch(/Do not analyse anything by other means/);
  });
});

describe('privacy and honesty rules', () => {
  it('forbids the CLI, other tools and raw content', () => {
    expect(body).toMatch(/Do not use Bash, Read, Grep/);
    expect(body).toMatch(/Do not run the `agenttrace` CLI/);
    expect(body).toMatch(/Never ask for, quote or reconstruct prompts, assistant messages, tool output/);
    expect(body).toMatch(/Never show an absolute local path/);
  });

  it('keeps include_commands off by default', () => {
    expect(body).toMatch(/Never pass `include_commands: true` unless the user asks/);
    expect(body).toMatch(/Command text is off by default/);
  });

  it('never calls API-equivalent cost the real bill', () => {
    expect(body).toMatch(/Never call it the actual bill/);
  });

  it('avoids unsupported waste claims and invented advice', () => {
    expect(body).toMatch(/Never say time was wasted unless/);
    expect(body).toMatch(/Do not invent problems, advice or recommendations/);
    expect(body).toMatch(/Do not suggest `CLAUDE.md` rules/);
  });

  it('does not allow Bash and has no CLI fallback commands', () => {
    expect(frontmatter).not.toMatch(/Bash/);
    expect(skill).not.toMatch(/agenttrace (analyze|report|summary)/);
    expect(skill).not.toMatch(/node dist\//);
  });

  it('contains no local absolute paths', () => {
    for (const f of [SKILL_FILE, join(PLUGIN, 'README.md'), join(PLUGIN, '.mcp.json'), join(PLUGIN, '.claude-plugin/plugin.json')]) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/\/Users\/|\/home\//);
    }
  });
});

describe('plugin manifest and MCP config', () => {
  it('has a valid manifest', () => {
    const m = readJson(join(PLUGIN, '.claude-plugin/plugin.json'));
    expect(m.name).toBe('agenttrace');
    expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(m.license).toBe('MIT');
  });

  it('launches the pinned published package over stdio', () => {
    const cfg = readJson(join(PLUGIN, '.mcp.json'));
    expect(Object.keys(cfg.mcpServers)).toEqual(['agenttrace']);
    const s = cfg.mcpServers.agenttrace;
    expect(s.command).toBe('npx');
    expect(s.args).toEqual(['-y', `@vukkisa/agenttrace@${pkg.version}`, 'mcp']);
    expect(s.url).toBeUndefined();
  });

  it('keeps the plugin version in step with the package version', () => {
    expect(readJson(join(PLUGIN, '.claude-plugin/plugin.json')).version).toBe(pkg.version);
  });

  it('documents Node 22+, the namespaced command and removal', () => {
    const readme = readFileSync(join(PLUGIN, 'README.md'), 'utf8');
    expect(readme).toMatch(/Node\.js 22/);
    expect(readme).toContain('/agenttrace:agenttrace');
    expect(readme).toMatch(/claude --plugin-dir/);
    expect(readme).toMatch(/uninstall/i);
    expect(readme).toMatch(/duplicate/i);
  });

  it('lists the plugin in a marketplace file whose version matches', () => {
    const mk = readJson(join(ROOT, '.claude-plugin/marketplace.json'));
    expect(mk.name).toBe('agenttrace');
    expect(mk.plugins).toHaveLength(1);
    const p = mk.plugins[0];
    expect(p.name).toBe('agenttrace');
    expect(p.source).toBe('./plugins/agenttrace');
    expect(existsSync(join(ROOT, p.source, '.claude-plugin/plugin.json'))).toBe(true);
    expect(p.version).toBe(pkg.version);
  });

  it('has no commands/ copy that could drift from the skill', () => {
    expect(existsSync(join(PLUGIN, 'commands'))).toBe(false);
  });
});

describe('install script', () => {
  const sh = (dir: string, ...args: string[]) =>
    spawnSync('bash', [INSTALLER, ...args], { env: { ...process.env, CLAUDE_SKILLS_DIR: dir }, encoding: 'utf8' });
  const fresh = () => mkdtempSync(join(tmpdir(), 'at-skill-'));

  it('is a dry run by default and changes nothing', () => {
    const dir = fresh();
    const r = sh(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('[dry run]');
    expect(existsSync(join(dir, 'agenttrace/SKILL.md'))).toBe(false);
  });

  it('installs an identical copy with --apply and is idempotent', () => {
    const dir = fresh();
    expect(sh(dir, '--apply').status).toBe(0);
    expect(readFileSync(join(dir, 'agenttrace/SKILL.md'), 'utf8')).toBe(skill);
    expect(sh(dir, '--apply').stdout).toContain('Already installed');
  });

  it('refuses to overwrite a foreign skill, and --force backs it up', () => {
    const dir = fresh();
    mkdirSync(join(dir, 'agenttrace'));
    writeFileSync(join(dir, 'agenttrace/SKILL.md'), 'my own skill\n');
    const refused = sh(dir, '--apply');
    expect(refused.status).toBe(1);
    expect(readFileSync(join(dir, 'agenttrace/SKILL.md'), 'utf8')).toBe('my own skill\n');
    expect(sh(dir, '--apply', '--force').status).toBe(0);
    expect(readFileSync(join(dir, 'agenttrace/SKILL.md.bak'), 'utf8')).toBe('my own skill\n');
    expect(readFileSync(join(dir, 'agenttrace/SKILL.md'), 'utf8')).toBe(skill);
  });

  it('uninstalls only its own file', () => {
    const dir = fresh();
    sh(dir, '--apply');
    const dry = sh(dir, '--uninstall');
    expect(dry.stdout).toContain('[dry run]');
    expect(existsSync(join(dir, 'agenttrace/SKILL.md'))).toBe(true);
    expect(sh(dir, '--uninstall', '--apply').status).toBe(0);
    expect(existsSync(join(dir, 'agenttrace'))).toBe(false);

    mkdirSync(join(dir, 'agenttrace'));
    writeFileSync(join(dir, 'agenttrace/SKILL.md'), 'not ours\n');
    expect(sh(dir, '--uninstall', '--apply').status).toBe(1);
    expect(existsSync(join(dir, 'agenttrace/SKILL.md'))).toBe(true);
  });

  it('never touches MCP registrations or settings', () => {
    const src = readFileSync(INSTALLER, 'utf8');
    expect(src).not.toMatch(/claude mcp|settings\.json|\.claude\.json/);
  });
});
