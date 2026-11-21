import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClaudeSession } from '../../src/parsers/claude/index.js';
import { parseCodexSession } from '../../src/parsers/codex/index.js';
import { analyzeSession, summarizeMany } from '../../src/analytics/analyze.js';
import { loadPricing, resolvePrice } from '../../src/pricing/index.js';
import { costForModel, summarizeCost } from '../../src/analytics/costs/index.js';
import { summarizeTokens, emptyTotals } from '../../src/analytics/tokens/index.js';
import { analyzeTiming } from '../../src/analytics/timing/index.js';
import { detectLoops } from '../../src/analytics/loops/index.js';
import { detectFailures } from '../../src/analytics/failures/index.js';
import type { NormalizedSession, ToolCall } from '../../src/types.js';
import { redact } from '../../src/privacy/redact.js';

const FX = path.join(__dirname, '..', 'fixtures');
const CLAUDE_MAIN = path.join(FX, 'claude/projects/-home-dev-demo-app/11111111-1111-4111-8111-111111111111.jsonl');
const CLAUDE_SUB = path.join(FX, 'claude/projects/-home-dev-demo-app/11111111-1111-4111-8111-111111111111/subagents/agent-a1b2c3.jsonl');
const CODEX = path.join(FX, 'codex/sessions/2026/11/19/rollout-2026-11-19T12-00-00-0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee.jsonl');
const pricing = loadPricing({ useUserFile: false });

describe('tokens', () => {
  it('groups by model, day and subagent', async () => {
    const s = await parseClaudeSession('1111', CLAUDE_MAIN, [CLAUDE_SUB]);
    const t = summarizeTokens(s.usage);
    expect(t.total.input).toBe(71 + 5 + 3);
    expect(t.total.output).toBe(490 + 300 + 25);
    expect(Object.keys(t.byModel).sort()).toEqual(['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
    expect(t.subagent.output).toBe(25);
    expect(t.byDay['(no timestamp)'].records).toBe(1);
    expect(t.total.cacheWrite1h).toBe(1000);
  });
});

describe('pricing and cost', () => {
  it('uses exact matches and never fuzzy-matches unknown models', () => {
    expect(resolvePrice(pricing, 'claude-sonnet-5-5')?.inputPerMTok).toBe(2);
    expect(resolvePrice(pricing, 'gpt-5-codex')?.model).toBe('gpt-5');
    expect(resolvePrice(pricing, 'claude-sonnet-5-5-20260101')?.model).toBe('claude-sonnet-5-5');
    expect(resolvePrice(pricing, 'claude-sonnet-5-5-experimental')).toBeUndefined();
    expect(resolvePrice(pricing, 'mystery-model-1')).toBeUndefined();
  });

  it('computes cost per component', () => {
    const t = { ...emptyTotals(), input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 2_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 };
    const c = costForModel('claude-sonnet-5-5', t, pricing);
    expect(c.status).toBe('complete');
    expect(c.breakdown!.input).toBeCloseTo(2);
    expect(c.breakdown!.output).toBeCloseTo(10);
    expect(c.breakdown!.cacheRead).toBeCloseTo(0.1);
    expect(c.breakdown!.cacheWrite).toBeCloseTo(2.5 + 4);
  });

  it('marks cost unavailable for unknown models and partial when mixed', async () => {
    const f = path.join(FX, 'claude/projects/-home-dev-other/33333333-3333-4333-8333-333333333333.jsonl');
    const s = await parseClaudeSession('3333', f, []);
    const c = summarizeCost(summarizeTokens(s.usage), pricing);
    expect(c.status).toBe('unavailable');
    expect(c.totalUsd).toBeUndefined();
    expect(c.unknownModels).toEqual(['mystery-model-1']);

    const mixed = summarizeTokens([...s.usage, { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, model: 'claude-sonnet-5-5', source: 'per-message' }]);
    const c2 = summarizeCost(mixed, pricing);
    expect(c2.status).toBe('partial');
    expect(c2.totalUsd).toBeCloseTo(0.002);
  });

  it('refuses to price when a needed component price is missing', () => {
    const table = { entries: [{ model: 'x', inputPerMTok: 1, outputPerMTok: 1, source: 't', lastUpdated: 't' }], loadedFrom: [] };
    const c = costForModel('x', { ...emptyTotals(), input: 10, cacheRead: 10 }, table);
    expect(c.status).toBe('missing-price-component');
    expect(c.missing).toEqual(['cacheReadPerMTok']);
    expect(c.costUsd).toBeUndefined();
  });

  it('loads custom prices for proxy providers', () => {
    const t = loadPricing({ pricingFile: path.join(FX, 'pricing.json'), useUserFile: false });
    expect(resolvePrice(t, 'omniroute/claude-sonnet')?.outputPerMTok).toBe(12);
    expect(t.loadedFrom).toHaveLength(1);
  });

  it('reports cost as unavailable when no usage exists', () => {
    expect(summarizeCost(summarizeTokens([]), pricing).status).toBe('unavailable');
  });
});

describe('timing', () => {
  it('computes observed duration, pauses and tool durations', async () => {
    const s = await parseClaudeSession('1111', CLAUDE_MAIN, []);
    const t = analyzeTiming(s, 5 * 60_000);
    expect(t.start!.toISOString()).toBe('2026-11-19T10:30:00.000Z');
    expect(t.end!.toISOString()).toBe('2026-11-19T11:00:30.000Z');
    expect(t.observedMs).toBe(30.5 * 60_000);
    expect(t.pauses).toHaveLength(1); // 10:44:30 -> 11:00:00
    expect(t.activeMs).toBe(t.observedMs! - t.pauses[0].ms);
    const bash = t.toolTimes.find(x => x.tool === 'Bash')!;
    expect(bash.measuredCalls).toBe(0);
    expect(bash.logIntervalCalls).toBe(7);
    const sumCats = Object.values(t.categoriesMs).reduce((a, b) => a + b, 0);
    expect(sumCats).toBe(t.observedMs);
  });

  it('uses measured durations from Codex exec events', async () => {
    const t = analyzeTiming(await parseCodexSession(CODEX));
    const shell = t.toolTimes.find(x => x.tool === 'shell')!;
    expect(shell.measuredCalls).toBe(4);
    expect(shell.measuredMs).toBe(10_000);
  });
});

describe('failure and loop detection (Claude fixture)', () => {
  it('flags the repeated failing test with evidence', async () => {
    const a = analyzeSession(await parseClaudeSession('1111', CLAUDE_MAIN, [CLAUDE_SUB]), pricing);
    const f = a.findings.find(x => x.kind === 'repeated-failed-test')!;
    expect(f).toBeDefined();
    expect(f.subject).toBe('pytest tests/test_auth.py');
    expect(f.occurrences).toBe(6);
    expect(f.failures).toBe(5);
    expect(f.eventuallySucceeded).toBe(true);
    expect(f.modificationsBetween).toBe(1);
    expect(f.label).toBe('REPEATED FAILURE DETECTED');
    expect(f.basis).toBe('measured');
    expect(f.firstAt!.toISOString()).toBe('2026-11-19T10:32:00.000Z');
    expect(f.evidence[0].errorSnippet).toBeUndefined(); // not shown by default
  });

  it('flags repeated unchanged reads but not reads after an edit', async () => {
    const a = analyzeSession(await parseClaudeSession('1111', CLAUDE_MAIN, []), pricing);
    const r = a.findings.find(x => x.kind === 'repeated-read')!;
    expect(r.occurrences).toBe(5);
    expect(r.evidence).toHaveLength(3); // read3, read4, read5 (read1/read2 are a separate segment of 2)
    expect(r.basis).toBe('heuristic');
  });

  it('labels loops as possible repetitive behaviour with evidence', async () => {
    const a = analyzeSession(await parseClaudeSession('1111', CLAUDE_MAIN, []), pricing);
    expect(a.loops.length).toBeGreaterThanOrEqual(2);
    for (const l of a.loops) {
      expect(l.label).toBe('Possible repetitive behaviour');
      expect(l.basis).toBe('heuristic');
      expect(l.evidence.length).toBeGreaterThan(0);
      expect(l.why.length).toBeGreaterThan(20);
    }
    const retry = a.loops.find(l => l.title.startsWith('Failing test re-run'))!;
    expect(retry.occurrences).toBe(3); // the edit at 10:37 breaks the chain
  });

  it('respects the configurable threshold', async () => {
    const s = await parseClaudeSession('1111', CLAUDE_MAIN, []);
    const a = analyzeSession(s, pricing, { threshold: 6 });
    expect(a.findings.find(x => x.kind === 'repeated-failed-test')).toBeUndefined();
    expect(a.loops).toHaveLength(0);
  });

  it('includes redacted error snippets only when asked', async () => {
    const a = analyzeSession(await parseClaudeSession('1111', CLAUDE_MAIN, []), pricing, { includeErrorSnippets: true });
    const f = a.findings.find(x => x.kind === 'repeated-failed-test')!;
    expect(f.evidence[0].errorSnippet).toMatch(/Exit code 1/);
  });

  it('produces an evidence-based diagnosis and a bounded waste estimate', async () => {
    const a = analyzeSession(await parseClaudeSession('1111', CLAUDE_MAIN, []), pricing);
    expect(a.diagnosis.some(d => /5 failed runs of the same test command/.test(d.text))).toBe(true);
    expect(a.waste.repeatedFailureMs).toBeGreaterThan(0);
    expect(a.waste.repeatedFailureMs).toBeLessThanOrEqual(a.timing.observedMs!);
    expect(a.cost.status).toBe('complete');
  });
});

describe('failure and loop detection (Codex fixture)', () => {
  it('detects the repeated npm test failure and the retry-without-change loop', async () => {
    const a = analyzeSession(await parseCodexSession(CODEX), pricing);
    const f = a.findings.find(x => x.kind === 'repeated-failed-test')!;
    expect(f.failures).toBe(3);
    expect(f.eventuallySucceeded).toBe(true);
    expect(f.modificationsBetween).toBe(0);
    expect(a.loops.some(l => l.title.startsWith('Failing test re-run'))).toBe(true);
    expect(a.cost.status).toBe('complete');
    expect(a.counts.interruptions).toBe(1);
  });

  it('summarizes multiple sessions', async () => {
    const a1 = analyzeSession(await parseCodexSession(CODEX), pricing);
    const a2 = analyzeSession(await parseClaudeSession('1111', CLAUDE_MAIN, []), pricing);
    const m = summarizeMany([a1, a2], pricing);
    expect(m.sessions).toHaveLength(2);
    expect(m.total.output).toBe(a1.tokens.total.output + a2.tokens.total.output);
    expect(m.cost.totalUsd).toBeCloseTo((a1.cost.totalUsd ?? 0) + (a2.cost.totalUsd ?? 0));
  });
});

describe('loop detection edge cases', () => {
  const mk = (i: number, over: Partial<ToolCall>): ToolCall => ({
    id: 'c' + i, name: 'Bash', timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)), status: 'success',
    inputKey: 'Bash:cmd:git status', inputSummary: 'git status', command: 'git status', ...over,
  });
  const session = (calls: ToolCall[]): NormalizedSession => ({
    agent: 'claude-code', sessionId: 's', files: [], models: [], usage: [], usageAvailable: false, toolCalls: calls,
    boundaries: [], eventTimes: [], apiErrors: 0, interruptions: 0, diagnostics: [],
  });
  const cfg = { threshold: 3, similarErrorWindowMs: 600_000, includeErrorSnippets: false };

  it('does not flag short successful read-only polling', () => {
    expect(detectLoops(session([0, 1, 2, 3].map(i => mk(i, {}))), cfg)).toHaveLength(0);
  });
  it('flags long identical polling as possible repetitive behaviour', () => {
    expect(detectLoops(session([0, 1, 2, 3, 4, 5].map(i => mk(i, {}))), cfg)).toHaveLength(1);
  });
  it('detects a 2-step cycle', () => {
    const calls: ToolCall[] = [];
    for (let i = 0; i < 6; i++) {
      calls.push(i % 2 === 0
        ? mk(i, { name: 'Edit', inputKey: 'Edit:abc', inputSummary: 'a.py', command: undefined, modifiedPaths: ['a.py'] })
        : mk(i, { inputKey: 'Bash:cmd:pytest', inputSummary: 'pytest', command: 'pytest', status: 'error', errorSignature: 'e' }));
    }
    const loops = detectLoops(session(calls), cfg);
    expect(loops.some(l => l.title.includes('2-step sequence repeated 3 times'))).toBe(true);
  });
});

describe('permission errors and weak loops (real-data accuracy fixes)', () => {
  const mk = (min: number, over: Partial<ToolCall> = {}): ToolCall => ({
    id: 'p' + min + Math.random(), name: 'Bash', timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0) + min * 60_000), status: 'error',
    errorClass: 'permission', errorSignature: 'denied', inputKey: 'Bash:cmd:x' + min, inputSummary: 'x', command: 'x', ...over,
  });
  const session = (calls: ToolCall[]): NormalizedSession => ({
    agent: 'claude-code', sessionId: 's', files: [], models: [], usage: [], usageAvailable: false, toolCalls: calls,
    boundaries: [], eventTimes: [], apiErrors: 0, interruptions: 0, diagnostics: [],
  });
  const cfg = { threshold: 3, similarErrorWindowMs: 600_000, includeErrorSnippets: false };

  it('does not flag permission denials spread over days', () => {
    const day = 24 * 60;
    expect(detectFailures(session([0, day, 3 * day, 20 * day].map(m => mk(m))), cfg).filter(f => f.kind === 'repeated-permission-error')).toHaveLength(0);
  });
  it('flags a burst of permission denials and counts only the burst', () => {
    const f = detectFailures(session([0, 2, 5, 30 * 24 * 60].map(m => mk(m))), cfg).filter(x => x.kind === 'repeated-permission-error');
    expect(f).toHaveLength(1);
    expect(f[0].occurrences).toBe(3);
    expect(f[0].spanMs).toBeLessThanOrEqual(5 * 60_000);
  });

  const ui = (i: number): ToolCall => ({
    id: 'u' + i, name: 'mcp__browser__computer', timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)), status: 'success',
    inputKey: 'computer:screenshot', inputSummary: 'computer', ...{},
  });
  it('does not flag 3 successful identical UI-tool calls as a loop', () => {
    expect(detectLoops(session([0, 1, 2].map(ui)), cfg)).toHaveLength(0);
    expect(detectLoops(session([0, 1, 2, 3, 4].map(ui)), cfg)).toHaveLength(0);
  });
  it('still flags long successful repetition and short failing repetition', () => {
    expect(detectLoops(session([0, 1, 2, 3, 4, 5].map(ui)), cfg)).toHaveLength(1);
    const failing = [0, 1, 2].map(i => ({ ...ui(i), status: 'error' as const, errorSignature: 'e' }));
    expect(detectLoops(session(failing), cfg)).toHaveLength(1);
  });
});

describe('redaction', () => {
  it('redacts common secrets', () => {
    const s = redact('curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123" -d api_key=supersecret123 sk-ant-api03-AAAAAAAAAAAAAAAA ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaa AKIAABCDEFGHIJKLMNOP');
    expect(s).not.toMatch(/abcdefghijklmnopqrstuvwxyz123|supersecret123|sk-ant-api03|ghp_a|AKIAABCD/);
  });
});
