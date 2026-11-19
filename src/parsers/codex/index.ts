/**
 * Codex CLI rollout parser ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]).
 *
 * Current format: one {timestamp, type, payload} object per line, where type is
 *   session_meta | turn_context | response_item | event_msg | compacted.
 * Legacy format (early 2025): first line {id, timestamp, instructions}, then bare
 *   response items ({type: "message" | "function_call" | ...}) and {record_type: "state"}.
 *
 * Token usage: event_msg/token_count carries info.total_token_usage (CUMULATIVE for the
 * session) and info.last_token_usage (the latest request). The same snapshot is often
 * emitted more than once, so we take deltas between successive cumulative totals and
 * never sum snapshots. OpenAI semantics: input_tokens INCLUDES cached_input_tokens, and
 * output_tokens INCLUDES reasoning_output_tokens.
 *
 * Everything not recognised is counted in diagnostics, never fatal.
 */
import path from 'node:path';
import type { NormalizedSession, ParserDiagnostics, ToolCall, UsageRecord } from '../../types.js';
import { inc, isObj, num, parseTime, readJsonl, str } from '../jsonl.js';
import { classifyError, errorSignature, errorSnippet, exitCodeFromText } from '../normalize.js';
import { describeInput } from '../toolinput.js';

const KNOWN_TOP = new Set(['session_meta', 'turn_context', 'response_item', 'event_msg', 'compacted']);
const KNOWN_ITEMS = new Set([
  'message', 'reasoning', 'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output',
  'local_shell_call', 'web_search_call', 'tool_search_call', 'tool_search_output', 'image_generation_call', 'compaction', 'ghost_snapshot',
]);
const KNOWN_EVENTS = new Set([
  'token_count', 'user_message', 'agent_message', 'agent_reasoning', 'agent_reasoning_raw_content', 'agent_reasoning_section_break',
  'exec_command_begin', 'exec_command_end', 'exec_command_output_delta', 'exec_approval_request', 'apply_patch_approval_request',
  'patch_apply_begin', 'patch_apply_end', 'task_started', 'task_complete', 'turn_aborted', 'turn_diff', 'error', 'stream_error',
  'mcp_tool_call_begin', 'mcp_tool_call_end', 'web_search_begin', 'web_search_end', 'background_event', 'entered_review_mode',
  'exited_review_mode', 'context_compacted', 'item_started', 'item_completed', 'plan_update', 'view_image_tool_call', 'warning',
  'session_configured', 'turn_started', 'turn_complete',
]);

interface Totals { input: number; cached: number; output: number; reasoning: number; total: number }

function totalsFrom(u: unknown): Totals | undefined {
  if (!isObj(u)) return undefined;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (input === undefined && output === undefined) return undefined;
  const cached = num(u.cached_input_tokens) ?? 0;
  const reasoning = num(u.reasoning_output_tokens) ?? 0;
  return { input: input ?? 0, cached, output: output ?? 0, reasoning, total: num(u.total_tokens) ?? (input ?? 0) + (output ?? 0) };
}

function toUsage(t: Totals, model: string | undefined, ts: Date | undefined, source: UsageRecord['source']): UsageRecord {
  const cached = Math.min(t.cached, t.input);
  return {
    timestamp: ts, model, inputTokens: t.input - cached, outputTokens: t.output, cacheReadTokens: cached,
    cacheWriteTokens: 0, reasoningTokens: t.reasoning, source,
  };
}

function durationMs(v: unknown): number | undefined {
  if (typeof v === 'number') return v * 1000; // seconds
  if (isObj(v)) {
    const secs = num(v.secs) ?? 0; const nanos = num(v.nanos) ?? 0;
    if (v.secs !== undefined || v.nanos !== undefined) return secs * 1000 + nanos / 1e6;
  }
  if (typeof v === 'string') {
    const m = v.match(/^([\d.]+)\s*(ms|s)?$/);
    if (m) return Number(m[1]) * (m[2] === 'ms' ? 1 : 1000);
  }
  return undefined;
}

/** function_call_output.output is either a JSON string {output, metadata} or plain text. */
function parseOutput(out: unknown): { text: string; exitCode?: number; durationMs?: number; success?: boolean } {
  if (isObj(out)) {
    const text = str(out.content) ?? str(out.output) ?? '';
    const success = typeof out.success === 'boolean' ? out.success : undefined;
    return { text, success, exitCode: exitCodeFromText(text) };
  }
  const raw = typeof out === 'string' ? out : '';
  try {
    const j = JSON.parse(raw);
    if (isObj(j)) {
      const meta = isObj(j.metadata) ? j.metadata : {};
      const text = str(j.output) ?? '';
      return { text, exitCode: num(meta.exit_code) ?? exitCodeFromText(text), durationMs: num(meta.duration_seconds) !== undefined ? num(meta.duration_seconds)! * 1000 : undefined };
    }
  } catch { /* plain text */ }
  const wall = raw.match(/Wall time:\s*([\d.]+)\s*seconds/i);
  return { text: raw, exitCode: exitCodeFromText(raw), durationMs: wall ? Number(wall[1]) * 1000 : undefined };
}

export async function parseCodexSession(file: string): Promise<NormalizedSession> {
  const fallbackId = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1]
    ?? path.basename(file).replace(/\.jsonl(\.zst)?$/, '');
  const s: NormalizedSession = {
    agent: 'codex', sessionId: fallbackId, files: [file], models: [], usage: [], usageAvailable: false,
    toolCalls: [], boundaries: [], eventTimes: [], apiErrors: 0, interruptions: 0, diagnostics: [],
  };
  const diag: ParserDiagnostics = {
    file, totalLines: 0, parsedRecords: 0, malformedLines: 0, truncatedTail: false,
    recordTypeCounts: {}, unknownTypeCounts: {}, warnings: [],
  };
  s.diagnostics.push(diag);

  const calls = new Map<string, ToolCall>();
  const models = new Set<string>();
  let currentModel: string | undefined;
  let prevTotal: Totals | undefined;
  let lastSeenLast: string | undefined;
  let sawTotals = false;
  let sawUserEvent = false;
  const fallbackUserPrompts: Date[] = [];
  let lastWasMalformed = false;
  let lastTs: Date | undefined;

  const addCall = (id: string | undefined, name: string, input: unknown, ts: Date | undefined) => {
    const callId = id ?? `anon-${calls.size}`;
    if (calls.has(callId)) return;
    calls.set(callId, { id: callId, name, timestamp: ts, status: 'unknown', ...describeInput(name, input) });
  };
  const applyResult = (id: string | undefined, ts: Date | undefined, r: { text: string; exitCode?: number; durationMs?: number; success?: boolean }) => {
    const call = id ? calls.get(id) : undefined;
    if (!call) { inc(diag.unknownTypeCounts, 'output(without matching call)'); return; }
    call.resultTimestamp = ts;
    if (r.exitCode !== undefined) call.exitCode = r.exitCode;
    const failed = r.success === false || (r.exitCode !== undefined && r.exitCode !== 0)
      || /^(error|failed|aborted)[:\s]/i.test(r.text.trim()) || /sandbox (denied|error)|rejected by user|was not approved/i.test(r.text);
    if (/aborted by user|interrupted/i.test(r.text.slice(0, 200)) && failed) call.status = 'interrupted';
    else call.status = failed ? 'error' : (call.status === 'error' ? 'error' : 'success');
    if (call.status === 'error') {
      call.errorClass = classifyError(r.text, call.exitCode);
      call.errorSignature = errorSignature(r.text);
      call.errorSnippet = errorSnippet(r.text);
    }
    if (r.durationMs !== undefined && call.durationSource !== 'measured') { call.durationMs = r.durationMs; call.durationSource = 'measured'; }
    else if (call.durationMs === undefined && call.timestamp && ts) {
      call.durationMs = Math.max(0, ts.getTime() - call.timestamp.getTime()); call.durationSource = 'log-interval';
    }
  };

  const handleItem = (p: Record<string, unknown>, ts: Date | undefined) => {
    const it = str(p.type) ?? '(none)';
    inc(diag.recordTypeCounts, 'response_item:' + it);
    if (!KNOWN_ITEMS.has(it)) inc(diag.unknownTypeCounts, 'response_item:' + it);
    switch (it) {
      case 'message':
        if (p.role === 'user' && ts) fallbackUserPrompts.push(ts);
        break;
      case 'function_call': {
        let args: unknown = p.arguments;
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* keep string */ } }
        addCall(str(p.call_id) ?? str(p.id), str(p.name) ?? 'function', args, ts);
        break;
      }
      case 'custom_tool_call':
        addCall(str(p.call_id) ?? str(p.id), str(p.name) ?? 'custom_tool', p.input, ts);
        if (p.status === 'failed') { const c = calls.get(str(p.call_id) ?? ''); if (c) c.status = 'error'; }
        break;
      case 'local_shell_call': {
        const action = isObj(p.action) ? p.action : {};
        addCall(str(p.call_id) ?? str(p.id), 'local_shell', action, ts);
        break;
      }
      case 'web_search_call':
        addCall(str(p.id) ?? undefined, 'web_search', isObj(p.action) ? p.action : {}, ts);
        break;
      case 'function_call_output':
      case 'custom_tool_call_output':
        applyResult(str(p.call_id), ts, parseOutput(p.output));
        break;
    }
  };

  for await (const line of readJsonl(file)) {
    diag.totalLines = line.lineNo;
    if (line.malformed) { diag.malformedLines++; lastWasMalformed = true; continue; }
    lastWasMalformed = false;
    const rec = line.value;
    if (!isObj(rec)) { diag.malformedLines++; continue; }
    diag.parsedRecords++;
    const ts = parseTime(rec.timestamp);
    if (ts) {
      s.eventTimes.push(ts);
      if (!s.startTime || ts < s.startTime) s.startTime = ts;
      if (!s.endTime || ts > s.endTime) s.endTime = ts;
      lastTs = ts;
    }
    const type = str(rec.type);
    const payload = isObj(rec.payload) ? rec.payload : undefined;

    // ---- legacy format ----
    if (!payload) {
      if (rec.record_type === 'state') { inc(diag.recordTypeCounts, 'legacy:state'); continue; }
      if (line.lineNo === 1 && str(rec.id) && !type) {
        inc(diag.recordTypeCounts, 'legacy:session_meta');
        s.sessionId = str(rec.id)!;
        continue;
      }
      if (type && KNOWN_ITEMS.has(type)) { handleItem(rec, ts); continue; }
      inc(diag.recordTypeCounts, type ?? '(none)');
      inc(diag.unknownTypeCounts, type ?? '(none)');
      continue;
    }

    if (!type || !KNOWN_TOP.has(type)) {
      inc(diag.recordTypeCounts, type ?? '(none)');
      inc(diag.unknownTypeCounts, type ?? '(none)');
      continue;
    }

    if (type === 'session_meta') {
      inc(diag.recordTypeCounts, type);
      const meta = isObj(payload.meta) ? payload.meta : payload;
      if (str(meta.id)) s.sessionId = str(meta.id)!;
      s.projectDir ??= str(meta.cwd);
      s.cliVersion ??= str(meta.cli_version);
      const git = isObj(meta.git) ? meta.git : isObj(payload.git) ? payload.git : undefined;
      if (git) s.gitBranch ??= str(git.branch);
      const mt = parseTime(meta.timestamp);
      if (mt && (!s.startTime || mt < s.startTime)) s.startTime = mt;
    } else if (type === 'turn_context') {
      inc(diag.recordTypeCounts, type);
      const m = str(payload.model);
      if (m) { currentModel = m; models.add(m); }
      s.projectDir ??= str(payload.cwd);
    } else if (type === 'compacted') {
      inc(diag.recordTypeCounts, type);
      if (ts) s.boundaries.push({ timestamp: ts, kind: 'compaction' });
    } else if (type === 'response_item') {
      handleItem(payload, ts);
    } else if (type === 'event_msg') {
      const ev = str(payload.type) ?? '(none)';
      inc(diag.recordTypeCounts, 'event_msg:' + ev);
      if (!KNOWN_EVENTS.has(ev)) inc(diag.unknownTypeCounts, 'event_msg:' + ev);
      switch (ev) {
        case 'token_count': {
          const info = isObj(payload.info) ? payload.info : undefined;
          if (!info) break;
          const total = totalsFrom(info.total_token_usage);
          if (total) {
            sawTotals = true;
            let delta: Totals;
            if (!prevTotal) delta = total;
            else if (total.total < prevTotal.total || total.input < prevTotal.input) {
              // Counter went backwards (e.g. new process on resume): treat as a new baseline.
              diag.warnings.push(`line ${line.lineNo}: cumulative token total decreased; treated as reset`);
              delta = total;
            } else {
              delta = {
                input: total.input - prevTotal.input, cached: total.cached - prevTotal.cached,
                output: total.output - prevTotal.output, reasoning: total.reasoning - prevTotal.reasoning,
                total: total.total - prevTotal.total,
              };
            }
            prevTotal = total;
            if (delta.input || delta.output || delta.cached) s.usage.push(toUsage(delta, currentModel, ts, 'cumulative-delta'));
          } else if (!sawTotals) {
            // Only per-request numbers available: de-duplicate identical consecutive snapshots.
            const last = totalsFrom(info.last_token_usage);
            if (last) {
              const key = JSON.stringify(last);
              if (key !== lastSeenLast) s.usage.push(toUsage(last, currentModel, ts, 'last-turn'));
              lastSeenLast = key;
            }
          }
          break;
        }
        case 'user_message':
          sawUserEvent = true;
          if (ts) s.boundaries.push({ timestamp: ts, kind: 'user-prompt' });
          break;
        case 'task_complete':
        case 'turn_complete':
          if (ts) s.boundaries.push({ timestamp: ts, kind: 'assistant-end' });
          break;
        case 'turn_aborted':
          s.interruptions++;
          if (ts) s.boundaries.push({ timestamp: ts, kind: 'interrupt' });
          break;
        case 'error':
        case 'stream_error':
          s.apiErrors++;
          if (ts) s.boundaries.push({ timestamp: ts, kind: 'api-error' });
          break;
        case 'exec_command_end': {
          const id = str(payload.call_id);
          const call = id ? calls.get(id) : undefined;
          if (!call) break;
          const code = num(payload.exit_code);
          const d = durationMs(payload.duration);
          const out = str(payload.aggregated_output) ?? str(payload.stderr) ?? str(payload.formatted_output) ?? '';
          if (code !== undefined) {
            call.exitCode = code;
            if (code !== 0) {
              call.status = 'error';
              call.errorClass = classifyError(out, code);
              call.errorSignature = errorSignature(out || `exit ${code}`);
              call.errorSnippet = errorSnippet(out);
            } else if (call.status === 'unknown') call.status = 'success';
          }
          if (d !== undefined) { call.durationMs = d; call.durationSource = 'measured'; }
          break;
        }
        case 'patch_apply_end': {
          const id = str(payload.call_id);
          const call = id ? calls.get(id) : undefined;
          if (call && payload.success === false) {
            call.status = 'error';
            const err = str(payload.stderr) ?? 'patch failed';
            call.errorClass = classifyError(err);
            call.errorSignature = errorSignature(err);
            call.errorSnippet = errorSnippet(err);
          } else if (call && payload.success === true && call.status === 'unknown') call.status = 'success';
          break;
        }
      }
    }
  }
  if (lastWasMalformed) {
    diag.truncatedTail = true;
    diag.warnings.push('last line is not valid JSON (file may still be being written)');
  }
  if (!sawUserEvent) for (const t of fallbackUserPrompts) s.boundaries.push({ timestamp: t, kind: 'user-prompt' });
  void lastTs;

  s.models = [...models];
  s.usageAvailable = s.usage.length > 0;
  s.toolCalls = [...calls.values()].sort((a, b) => (a.timestamp?.getTime() ?? 0) - (b.timestamp?.getTime() ?? 0));
  s.eventTimes.sort((a, b) => a.getTime() - b.getTime());
  s.boundaries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  return s;
}
