#!/usr/bin/env node
/**
 * AgentTrace CLI. Read-only with respect to agent logs, repositories and configuration.
 * The only files it writes are reports/templates at paths the user chooses (default: cwd).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'commander';
import { discover, findSession, loadSession, type DiscoveryOptions } from '../discovery/index.js';
import { analyzeSession } from '../analytics/analyze.js';
import { loadPricing, pricingTemplate, USER_PRICING_FILE, type PricingTable } from '../pricing/index.js';
import { renderMultiText, renderSessionText } from '../reports/text.js';
import { renderSessionHtml } from '../reports/html.js';
import { formatDuration } from '../analytics/timing/index.js';
import type { AgentName, SessionRef } from '../types.js';
import { summarizeSummaries, type SessionSummary } from '../analytics/summary.js';
import { collectSummaries } from '../cache/collect.js';
import { SummaryCache, cacheInfo, clearCache, defaultCacheDir, type CacheStats } from '../cache/index.js';
import { VERSION } from '../version.js';

interface GlobalOpts { claudeDir?: string; codexDir?: string; pricing?: string; agent?: string; cache?: boolean }

const program = new Command();
program
  .name('agenttrace')
  .description('Analyze local Claude Code and Codex session logs (read-only, offline).')
  .version(VERSION)
  .option('--claude-dir <path>', 'Claude Code config dir (or its projects/ dir). Default: $CLAUDE_CONFIG_DIR, ~/.claude, ~/.config/claude')
  .option('--codex-dir <path>', 'Codex home (or its sessions/ dir). Default: $CODEX_HOME or ~/.codex')
  .option('--pricing <file>', `Extra model prices (JSON). ${USER_PRICING_FILE} is also read if present.`)
  .addOption(new Option('--agent <name>', 'Only one agent').choices(['claude-code', 'codex']))
  .option('--no-cache', 'Do not read or write the local summary cache (always re-parse)');

function g(): GlobalOpts { return program.opts<GlobalOpts>(); }
function discOpts(): DiscoveryOptions {
  const o = g();
  return { claudeDir: o.claudeDir, codexDir: o.codexDir, agents: o.agent ? [o.agent as AgentName] : undefined };
}
function pricing(): PricingTable { return loadPricing({ pricingFile: g().pricing }); }
const json = (v: unknown) => JSON.stringify(v, null, 2);

function detectionOpts(o: { threshold?: string; showErrors?: boolean; pauseMinutes?: string }) {
  const threshold = o.threshold ? Number(o.threshold) : 3;
  if (!Number.isInteger(threshold) || threshold < 2) throw new Error('--threshold must be an integer >= 2');
  const pause = o.pauseMinutes ? Number(o.pauseMinutes) : 5;
  if (!(pause > 0)) throw new Error('--pause-minutes must be > 0');
  return { threshold, includeErrorSnippets: !!o.showErrors, pauseThresholdMs: pause * 60_000 };
}

function pickRef(o: { session?: string; latest?: boolean }): SessionRef {
  const { sessions } = discover(discOpts());
  if (!sessions.length) throw new Error('No sessions found. Use --claude-dir / --codex-dir or run "agenttrace scan".');
  if (o.session) return findSession(sessions, o.session);
  if (o.latest) return sessions[0];
  throw new Error('Specify --session <id> or --latest.');
}

type DetectionOpts = ReturnType<typeof detectionOpts>;

async function summaries(refs: SessionRef[], det: DetectionOpts, requireDetection: boolean): Promise<{ summaries: SessionSummary[]; stats: CacheStats; enabled: boolean }> {
  const cache = SummaryCache.open({ enabled: g().cache !== false });
  if (cache.note) console.error(`agenttrace: ${cache.note}`);
  const list = await collectSummaries(refs, { cache, detection: det, requireDetection, pricing, warn: m => console.error(m) });
  return { summaries: list, stats: cache.stats, enabled: cache.enabled };
}

function cacheLine(r: { stats: CacheStats; enabled: boolean }): string {
  if (!r.enabled) return 'cache: disabled (--no-cache); all sessions parsed';
  return `cache: ${r.stats.reused} reused, ${r.stats.parsed} parsed (new or changed)`;
}

const detectionFlags = (cmd: Command) => cmd
  .option('--threshold <n>', 'Repetition threshold', '3')
  .option('--pause-minutes <n>', 'Gap counted as a long pause', '5')
  .option('--show-errors', 'Include redacted first-line error excerpts (off by default)');

program.command('scan')
  .description('Discover Claude Code and Codex session logs')
  .option('--json', 'JSON output')
  .action((o: { json?: boolean }) => {
    const r = discover(discOpts());
    const counts = { 'claude-code': 0, codex: 0 } as Record<AgentName, number>;
    for (const s of r.sessions) counts[s.agent]++;
    if (o.json) { console.log(json({ roots: r.roots, counts, skipped: r.skipped })); return; }
    for (const root of r.roots) console.log(`${root.agent.padEnd(11)} ${root.exists ? '✓' : '✗'} ${root.dir}  (${root.source})`);
    console.log(`\nClaude Code sessions: ${counts['claude-code']}\nCodex sessions:       ${counts.codex}`);
    for (const s of r.skipped) console.log(`skipped ${s.file}: ${s.reason}`);
  });

program.command('sessions')
  .description('List sessions with dates, agents, models and IDs')
  .option('--limit <n>', 'Max sessions', '30')
  .option('--json', 'JSON output')
  .action(async (o: { limit: string; json?: boolean }) => {
    const refs = discover(discOpts()).sessions.slice(0, Number(o.limit) || 30);
    const res = await summaries(refs, detectionOpts({}), false);
    const rows = res.summaries.map(s => ({ agent: s.agent, sessionId: s.sessionId, start: s.start, durationMs: s.observedMs, models: s.models, project: s.projectDir, toolCalls: s.toolCalls, files: s.files }));
    if (o.json) { console.log(json(rows)); return; }
    if (!rows.length) { console.log('No sessions found.'); return; }
    for (const r of rows) {
      console.log(`${r.agent.padEnd(11)} ${r.sessionId}  ${(r.start ? r.start.toLocaleString() : '?').padEnd(22)} ${formatDuration(r.durationMs).padEnd(9)} ${(r.models.join(',') || '-').padEnd(24)} ${r.toolCalls} calls`);
    }
    console.error(cacheLine(res));
  });

detectionFlags(program.command('analyze')
  .description('Analyze one session (--session/--latest) or all sessions (--all)')
  .option('--session <id>', 'Session ID or unique prefix')
  .option('--latest', 'Most recently modified session')
  .option('--all', 'All discoverable sessions')
  .option('--json', 'JSON output'))
  .action(async (o: { session?: string; latest?: boolean; all?: boolean; json?: boolean; threshold?: string; showErrors?: boolean; pauseMinutes?: string }) => {
    const det = detectionOpts(o);
    const table = pricing();
    if (o.all) {
      const res = await summaries(discover(discOpts()).sessions, det, true);
      const m = summarizeSummaries(res.summaries, table);
      console.log(o.json ? json(m) : renderMultiText(m));
      if (!o.json) console.error(cacheLine(res));
      return;
    }
    const a = analyzeSession(await loadSession(pickRef(o)), table, det);
    console.log(o.json ? json(a) : renderSessionText(a));
  });

detectionFlags(program.command('report')
  .description('Write an offline HTML report for one session')
  .option('--session <id>', 'Session ID or unique prefix')
  .option('--latest', 'Most recently modified session')
  .option('--out <file>', 'Output path (default: ./agenttrace-report-<id>.html)'))
  .action(async (o: { session?: string; latest?: boolean; out?: string; threshold?: string; showErrors?: boolean; pauseMinutes?: string }) => {
    const a = analyzeSession(await loadSession(pickRef(o)), pricing(), detectionOpts(o));
    const out = path.resolve(o.out ?? `agenttrace-report-${a.sessionId.slice(0, 8)}.html`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, renderSessionHtml(a), { mode: 0o600 });
    console.log(`Report written: ${out}`);
  });

const cacheCmd = program.command('cache').description('Inspect or clear the local summary cache');
cacheCmd.command('info')
  .description('Show cache location and size')
  .option('--json', 'JSON output')
  .action((o: { json?: boolean }) => {
    const i = cacheInfo();
    if (o.json) { console.log(json(i)); return; }
    console.log(`Cache file: ${i.file}`);
    if (!i.exists) { console.log('Status:     empty (no cache file)'); return; }
    console.log(`Entries:    ${i.entries}\nSize:       ${((i.bytes ?? 0) / 1024).toFixed(1)} KB`);
    if (i.note) console.log(`Note:       ${i.note}`);
    console.log('Contents:   per-session counts, token totals, timing and file size/mtime only (no transcript text).');
  });
cacheCmd.command('clear')
  .description('Delete the cache file')
  .action(() => {
    console.log(clearCache() ? `Cache cleared: ${defaultCacheDir()}` : 'No cache to clear.');
  });

program.command('reports-clean')
  .description('Delete AgentTrace HTML reports (agenttrace-report-*.html) in a directory')
  .option('--dir <path>', 'Directory', '.')
  .option('--yes', 'Actually delete (otherwise only lists)')
  .action((o: { dir: string; yes?: boolean }) => {
    const dir = path.resolve(o.dir);
    const files = fs.readdirSync(dir).filter(f => /^agenttrace-report-.*\.html$/.test(f));
    if (!files.length) { console.log('No AgentTrace reports found.'); return; }
    for (const f of files) {
      if (o.yes) fs.unlinkSync(path.join(dir, f));
      console.log(`${o.yes ? 'deleted' : 'would delete'} ${path.join(dir, f)}`);
    }
    if (!o.yes) console.log('Re-run with --yes to delete.');
  });

program.command('inspect')
  .description('Parser diagnostics and record-type counts (no conversation content)')
  .option('--session <id>', 'Only this session')
  .option('--limit <n>', 'Max sessions when no --session', '50')
  .option('--json', 'JSON output')
  .action(async (o: { session?: string; limit: string; json?: boolean }) => {
    const all = discover(discOpts()).sessions;
    const refs = o.session ? [findSession(all, o.session)] : all.slice(0, Number(o.limit) || 50);
    const totals: Record<string, Record<string, number>> = { 'claude-code': {}, codex: {} };
    const unknown: Record<string, Record<string, number>> = { 'claude-code': {}, codex: {} };
    const issues: string[] = [];
    let malformed = 0; let records = 0;
    for (const ref of refs) {
      const s = await loadSession(ref);
      for (const d of s.diagnostics) {
        records += d.parsedRecords; malformed += d.malformedLines;
        for (const [k, v] of Object.entries(d.recordTypeCounts)) totals[s.agent][k] = (totals[s.agent][k] ?? 0) + v;
        for (const [k, v] of Object.entries(d.unknownTypeCounts)) unknown[s.agent][k] = (unknown[s.agent][k] ?? 0) + v;
        if (d.malformedLines || d.warnings.length) issues.push(`${d.file}: ${d.malformedLines} malformed line(s)${d.warnings.length ? '; ' + d.warnings.slice(0, 3).join('; ') : ''}`);
      }
      if (!s.usageAvailable && s.toolCalls.length) issues.push(`${s.agent} ${s.sessionId}: tool calls present but no token usage`);
    }
    const result = { sessions: refs.length, records, malformedLines: malformed, recordTypes: totals, unsupported: unknown, issues };
    if (o.json) { console.log(json(result)); return; }
    console.log(`Sessions inspected: ${refs.length}, records: ${records}, malformed lines: ${malformed}`);
    for (const agent of Object.keys(totals)) {
      if (!Object.keys(totals[agent]).length) continue;
      console.log(`\n${agent} record types:`);
      for (const [k, v] of Object.entries(totals[agent]).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(7)}  ${k}${unknown[agent][k] ? '  (unsupported)' : ''}`);
      const extra = Object.entries(unknown[agent]).filter(([k]) => !(k in totals[agent]));
      for (const [k, v] of extra) console.log(`  ${String(v).padStart(7)}  ${k}  (unsupported)`);
    }
    if (issues.length) { console.log('\nIssues:'); for (const i of issues.slice(0, 40)) console.log('  ' + i); }
  });

program.command('pricing')
  .description('Show the pricing table, or write a template for custom prices')
  .option('--init <file>', 'Write a pricing template to this path (never overwrites)')
  .option('--json', 'JSON output')
  .action((o: { init?: string; json?: boolean }) => {
    if (o.init) {
      const f = path.resolve(o.init);
      if (fs.existsSync(f)) throw new Error(`${f} already exists; not overwriting.`);
      fs.writeFileSync(f, pricingTemplate());
      console.log(`Template written: ${f}\nUse it with --pricing ${f} (or copy it to ${USER_PRICING_FILE}).`);
      return;
    }
    const t = pricing();
    if (o.json) { console.log(json(t)); return; }
    console.log('Model'.padEnd(22) + 'In $/M'.padStart(8) + 'Out $/M'.padStart(9) + 'CacheR'.padStart(8) + 'CacheW5m'.padStart(10) + 'CacheW1h'.padStart(10) + '  Updated     Source');
    for (const e of t.entries) {
      console.log(e.model.padEnd(22) + String(e.inputPerMTok).padStart(8) + String(e.outputPerMTok).padStart(9) + String(e.cacheReadPerMTok ?? '-').padStart(8) + String(e.cacheWrite5mPerMTok ?? '-').padStart(10) + String(e.cacheWrite1hPerMTok ?? '-').padStart(10) + '  ' + e.lastUpdated.padEnd(11) + ' ' + e.source);
    }
    if (t.loadedFrom.length) console.log(`\nOverrides loaded from: ${t.loadedFrom.join(', ')}`);
  });

program.command('mcp')
  .description('Run the local MCP server over stdio (list_sessions, analyze_session, get_failures, cost_summary). Read-only; stdout is protocol only.')
  .action(async () => {
    const { serveMcp } = await import('../mcp/server.js');
    serveMcp({
      discovery: discOpts(),
      pricingFile: g().pricing,
      cacheEnabled: g().cache !== false,
      log: m => console.error(`agenttrace-mcp: ${m}`),
    });
  });

program.parseAsync(process.argv).catch(e => {
  console.error(`agenttrace: ${(e as Error).message}`);
  process.exit(1);
});
