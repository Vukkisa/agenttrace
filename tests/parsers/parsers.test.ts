import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseClaudeSession } from '../../src/parsers/claude/index.js';
import { parseCodexSession } from '../../src/parsers/codex/index.js';
import { discover, findSession } from '../../src/discovery/index.js';
import { zstdSupported } from '../../src/parsers/jsonl.js';
import { normalizeCommand, isTestCommand, errorSignature, patchPaths } from '../../src/parsers/normalize.js';

const FX = path.join(__dirname, '..', 'fixtures');
const CLAUDE_MAIN = path.join(FX, 'claude/projects/-home-dev-demo-app/11111111-1111-4111-8111-111111111111.jsonl');
const CLAUDE_SUB = path.join(FX, 'claude/projects/-home-dev-demo-app/11111111-1111-4111-8111-111111111111/subagents/agent-a1b2c3.jsonl');
const CODEX = path.join(FX, 'codex/sessions/2026/11/19/rollout-2026-11-19T12-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee.jsonl');
const CODEX_LEGACY = path.join(FX, 'codex/sessions/2025/04/20/rollout-2025-04-20T08-00-00-0196aaaa-0000-7000-8000-000000000001.jsonl');

describe('discovery', () => {
  it('finds Claude sessions (with subagents) and Codex sessions in configured dirs', () => {
    const r = discover({ claudeDir: path.join(FX, 'claude'), codexDir: path.join(FX, 'codex') });
    const claude = r.sessions.filter(s => s.agent === 'claude-code');
    const codex = r.sessions.filter(s => s.agent === 'codex');
    expect(claude).toHaveLength(3);
    expect(codex).toHaveLength(2);
    const main = claude.find(s => s.sessionId.startsWith('1111'))!;
    expect(main.files).toHaveLength(2);
    expect(findSession(r.sessions, '0199aaaa').agent).toBe('codex');
    expect(() => findSession(r.sessions, 'nope')).toThrow(/No session/);
  });

  it('accepts the projects/ dir directly and reports missing roots', () => {
    const r = discover({ claudeDir: path.join(FX, 'claude/projects'), codexDir: path.join(FX, 'does-not-exist') });
    expect(r.sessions.filter(s => s.agent === 'claude-code')).toHaveLength(3);
    expect(r.roots.find(x => x.agent === 'codex')!.exists).toBe(false);
  });
});

describe('Claude Code parser', () => {
  it('de-duplicates usage across records sharing a message id and merges subagents', async () => {
    const s = await parseClaudeSession('1111', CLAUDE_MAIN, [CLAUDE_SUB]);
    const sonnet = s.usage.filter(u => u.model === 'claude-sonnet-5-5');
    expect(sonnet).toHaveLength(14); // msg_01 has two records but counts once
    expect(sonnet.reduce((a, u) => a + u.inputTokens, 0)).toBe(71);
    expect(sonnet.reduce((a, u) => a + u.outputTokens, 0)).toBe(490);
    expect(s.models.sort()).toEqual(['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
    const sub = s.usage.filter(u => u.subagent);
    expect(sub).toHaveLength(1);
    expect(sub[0].model).toBe('claude-haiku-5-5');
    const first = s.usage.find(u => u.cacheWrite1hTokens === 1000)!;
    expect(first.cacheWrite5mTokens).toBe(4000);
  });

  it('pairs tool calls with results and classifies outcomes', async () => {
    const s = await parseClaudeSession('1111', CLAUDE_MAIN, [CLAUDE_SUB]);
    expect(s.toolCalls).toHaveLength(14);
    const byId = Object.fromEntries(s.toolCalls.map(c => [c.id, c]));
    expect(byId.tu_t1.status).toBe('error');
    expect(byId.tu_t1.exitCode).toBe(1);
    expect(byId.tu_t1.command).toBe('pytest tests/test_auth.py');
    expect(byId.tu_t6.status).toBe('success');
    expect(byId.tu_int.status).toBe('interrupted');
    expect(byId.tu_edit.modifiedPaths).toEqual(['/home/dev/demo-app/src/auth.py']);
    expect(byId.tu_read1.readPaths).toEqual(['/home/dev/demo-app/src/auth.py']);
    expect(byId.tu_t1.durationSource).toBe('log-interval');
    expect(byId.tu_t1.durationMs).toBe(30_000);
    expect(byId.tu_sub1.subagent).toBe(true);
  });

  it('tolerates malformed lines, a partially written tail, unknown types and missing timestamps', async () => {
    const s = await parseClaudeSession('1111', CLAUDE_MAIN, []);
    const d = s.diagnostics[0];
    expect(d.malformedLines).toBe(2);
    expect(d.truncatedTail).toBe(true);
    expect(d.unknownTypeCounts['future-record-type']).toBe(1);
    expect(s.usage.some(u => u.timestamp === undefined)).toBe(true);
    expect(s.apiErrors).toBe(1);
    expect(s.gitBranch).toBe('feature/auth');
    expect(s.projectDir).toBe('/home/dev/demo-app');
    expect(s.boundaries.filter(b => b.kind === 'user-prompt')).toHaveLength(2);
  });

  it('handles an empty session file', async () => {
    const f = path.join(FX, 'claude/projects/-home-dev-other/22222222-2222-4222-8222-222222222222.jsonl');
    const s = await parseClaudeSession('2222', f, []);
    expect(s.usageAvailable).toBe(false);
    expect(s.toolCalls).toHaveLength(0);
    expect(s.startTime).toBeUndefined();
  });
});

describe('Codex parser', () => {
  it('takes deltas of cumulative token totals without double counting duplicate snapshots', async () => {
    const s = await parseCodexSession(CODEX);
    const sum = (m: string, k: 'inputTokens' | 'outputTokens' | 'cacheReadTokens') => s.usage.filter(u => u.model === m).reduce((a, u) => a + u[k], 0);
    expect(sum('gpt-5-codex', 'inputTokens')).toBe(1800); // 3000 input - 1200 cached
    expect(sum('gpt-5-codex', 'cacheReadTokens')).toBe(1200);
    expect(sum('gpt-5-codex', 'outputTokens')).toBe(400);
    expect(sum('gpt-5-mini', 'inputTokens')).toBe(1200);
    expect(sum('gpt-5-mini', 'cacheReadTokens')).toBe(800);
    expect(sum('gpt-5-mini', 'outputTokens')).toBe(200);
    expect(s.usage.every(u => u.source === 'cumulative-delta')).toBe(true);
  });

  it('extracts metadata, tool calls, exit codes and measured durations', async () => {
    const s = await parseCodexSession(CODEX);
    expect(s.sessionId).toBe('0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee');
    expect(s.projectDir).toBe('/home/dev/api');
    expect(s.gitBranch).toBe('fix/tests');
    expect(s.cliVersion).toBe('0.60.0');
    expect(s.models).toEqual(['gpt-5-codex', 'gpt-5-mini']);
    expect(s.toolCalls).toHaveLength(5);
    const c1 = s.toolCalls.find(c => c.id === 'call_1')!;
    expect(c1.command).toBe('npm test');
    expect(c1.status).toBe('error');
    expect(c1.exitCode).toBe(1);
    expect(c1.durationSource).toBe('measured');
    expect(c1.durationMs).toBe(2500);
    expect(s.toolCalls.find(c => c.id === 'call_2')!.command).toBe('npm test');
    const patch = s.toolCalls.find(c => c.id === 'call_p')!;
    expect(patch.modifiedPaths).toEqual(['src/sum.js']);
    expect(patch.status).toBe('success');
    expect(s.interruptions).toBe(1);
    expect(s.boundaries.filter(b => b.kind === 'user-prompt')).toHaveLength(2);
  });

  it('reports unknown record types instead of failing', async () => {
    const s = await parseCodexSession(CODEX);
    const d = s.diagnostics[0];
    expect(d.unknownTypeCounts['event_msg:future_event_type']).toBe(1);
    expect(d.unknownTypeCounts['mystery_top_level']).toBe(1);
    expect(d.malformedLines).toBe(0);
  });

  it('parses the legacy format with no per-item timestamps', async () => {
    const s = await parseCodexSession(CODEX_LEGACY);
    expect(s.sessionId).toBe('0196aaaa-0000-7000-8000-000000000001');
    expect(s.toolCalls).toHaveLength(1);
    expect(s.toolCalls[0].status).toBe('success');
    expect(s.toolCalls[0].command).toBe('ls -la');
    expect(s.usageAvailable).toBe(false);
  });

  it('handles a counter reset and last-turn-only usage', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttrace-'));
    const f = path.join(dir, 'rollout-x.jsonl');
    const tok = (ts: string, total: unknown) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total } } });
    fs.writeFileSync(f, [
      JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type: 'turn_context', payload: { model: 'gpt-5' } }),
      tok('2026-01-01T00:00:01Z', { input_tokens: 500, cached_input_tokens: 0, output_tokens: 50, total_tokens: 550 }),
      tok('2026-01-01T00:00:02Z', { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, total_tokens: 110 }),
      JSON.stringify({ timestamp: '2026-01-01T00:00:03Z', type: 'event_msg', payload: { type: 'token_count', info: null } }),
    ].join('\n'));
    const s = await parseCodexSession(f);
    expect(s.usage.reduce((a, u) => a + u.inputTokens, 0)).toBe(600);
    expect(s.diagnostics[0].warnings.some(w => /reset/.test(w))).toBe(true);

    const g = path.join(dir, 'rollout-y.jsonl');
    const last = (ts: string) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 5 } } } });
    fs.writeFileSync(g, [last('2026-01-01T00:00:01Z'), last('2026-01-01T00:00:01Z')].join('\n'));
    const s2 = await parseCodexSession(g);
    expect(s2.usage).toHaveLength(1);
    expect(s2.usage[0].source).toBe('last-turn');
  });

  it.runIf(zstdSupported())('reads .jsonl.zst rollouts', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttrace-'));
    const f = path.join(dir, 'rollout-2026-11-19T12-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee.jsonl.zst');
    const z = zlib as unknown as { zstdCompressSync: (b: Buffer) => Buffer };
    fs.writeFileSync(f, z.zstdCompressSync(fs.readFileSync(CODEX)));
    const s = await parseCodexSession(f);
    expect(s.toolCalls).toHaveLength(5);
  });
});

describe('large files', () => {
  it('streams a 60k-line Claude transcript', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttrace-'));
    const f = path.join(dir, 'big.jsonl');
    const lines: string[] = [];
    for (let i = 0; i < 20000; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      const usage = { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 0 };
      lines.push(JSON.stringify({ type: 'assistant', timestamp: ts, message: { id: 'm' + i, model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: 't' + i, name: 'Read', input: { file_path: `/f${i % 50}` } }], usage } }));
      lines.push(JSON.stringify({ type: 'assistant', timestamp: ts, message: { id: 'm' + i, model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'x' }], usage } }));
      lines.push(JSON.stringify({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: 't' + i, content: 'ok' }] } }));
    }
    fs.writeFileSync(f, lines.join('\n'));
    const s = await parseClaudeSession('big', f, []);
    expect(s.usage).toHaveLength(20000);
    expect(s.toolCalls).toHaveLength(20000);
    expect(s.usage.reduce((a, u) => a + u.outputTokens, 0)).toBe(40000);
  });
});

describe('normalization', () => {
  it('normalizes commands', () => {
    expect(normalizeCommand('cd /a/b && pytest -x tests 2>&1 | tail -n 30')).toBe('pytest -x tests');
    expect(normalizeCommand("bash -lc 'npm test'")).toBe('npm test');
    expect(normalizeCommand('npm   test')).toBe('npm test');
  });
  it('detects test commands', () => {
    for (const c of ['pytest tests/x.py', 'npm test', 'npm run test', 'go test ./...', 'cargo test', 'npx vitest run', 'python -m pytest']) expect(isTestCommand(c)).toBe(true);
    for (const c of ['ls -la', 'git status', 'cat test.txt']) expect(isTestCommand(c)).toBe(false);
  });
  it('builds stable error signatures', () => {
    expect(errorSignature('Error at /a/b/c.py:12 code 0x1f')).toBe(errorSignature('Error at /x/y.py:99 code 0xab'));
  });
  it('extracts apply_patch paths', () => {
    expect(patchPaths('*** Begin Patch\n*** Add File: a.ts\n*** Update File: b/c.ts\n*** End Patch')).toEqual(['a.ts', 'b/c.ts']);
  });
});
