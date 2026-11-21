/**
 * Claude Code transcript parser.
 *
 * Observed format (JSONL under <claude-dir>/projects/<encoded-cwd>/<session-id>.jsonl,
 * subagents under <session-id>/subagents/agent-*.jsonl):
 *  - type "assistant": message.{id, model, content[], usage}. One API response is split
 *    across several records (one per content block) that share message.id and repeat the
 *    same usage object, so usage MUST be de-duplicated by message.id.
 *  - type "user": either a prompt (message.content string / text blocks) or tool results
 *    (content[].type === "tool_result" with tool_use_id, is_error).
 *  - type "system": subtype api_error / compact_boundary / stop_hook_summary, ...
 *  - many other bookkeeping types (attachment, file-history-snapshot, ...) are counted only.
 */
import path from 'node:path';
import type { NormalizedSession, ParserDiagnostics, ToolCall, TurnBoundary, UsageRecord } from '../../types.js';
import { inc, isObj, num, parseTime, readJsonl, str } from '../jsonl.js';
import { classifyError, errorSignature, errorSnippet, exitCodeFromText } from '../normalize.js';
import { describeInput } from '../toolinput.js';

/** Record types we understand. Anything else is counted as "unknown" in diagnostics. */
const KNOWN_TYPES = new Set([
  'assistant', 'user', 'system', 'summary', 'attachment', 'file-history-snapshot', 'file-history-delta',
  'queue-operation', 'custom-title', 'ai-title', 'agent-name', 'last-prompt', 'mode', 'api-request',
  'api-request-blob', 'api-request-shape', 'atis-latch', 'bridge-session', 'cost-state', 'frame-link',
  'relocated', 'tools-used', 'progress', 'permission-mode', 'session-owner',
]);

interface State {
  session: NormalizedSession;
  usageByMsg: Map<string, UsageRecord>;
  calls: Map<string, ToolCall>;
  models: Set<string>;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => (isObj(c) && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n');
  }
  return '';
}

function usageFrom(u: Record<string, unknown>, model: string | undefined, ts: Date | undefined, subagent: boolean): UsageRecord {
  const cc = isObj(u.cache_creation) ? u.cache_creation : undefined;
  const w5 = cc ? num(cc.ephemeral_5m_input_tokens) : undefined;
  const w1 = cc ? num(cc.ephemeral_1h_input_tokens) : undefined;
  const otd = isObj(u.output_tokens_details) ? u.output_tokens_details : undefined;
  return {
    timestamp: ts,
    model,
    inputTokens: num(u.input_tokens) ?? 0,
    outputTokens: num(u.output_tokens) ?? 0,
    cacheReadTokens: num(u.cache_read_input_tokens) ?? 0,
    cacheWriteTokens: num(u.cache_creation_input_tokens) ?? ((w5 ?? 0) + (w1 ?? 0)),
    cacheWrite5mTokens: w5,
    cacheWrite1hTokens: w1,
    reasoningTokens: otd ? num(otd.thinking_tokens) : undefined,
    source: 'per-message',
    subagent: subagent || undefined,
  };
}

async function parseFile(file: string, st: State, subagent: boolean, ownId: string): Promise<void> {
  const diag: ParserDiagnostics = {
    file, totalLines: 0, parsedRecords: 0, malformedLines: 0, truncatedTail: false,
    recordTypeCounts: {}, unknownTypeCounts: {}, warnings: [],
  };
  st.session.diagnostics.push(diag);
  const s = st.session;
  let lastWasMalformed = false;

  for await (const line of readJsonl(file)) {
    diag.totalLines = line.lineNo;
    if (line.malformed) { diag.malformedLines++; lastWasMalformed = true; continue; }
    lastWasMalformed = false;
    const rec = line.value;
    if (!isObj(rec)) { diag.malformedLines++; continue; }
    diag.parsedRecords++;
    const type = str(rec.type) ?? '(none)';
    inc(diag.recordTypeCounts, type);
    if (!KNOWN_TYPES.has(type)) inc(diag.unknownTypeCounts, type);

    // Resumed sessions replay earlier history with the ORIGINAL sessionId. Those records belong to
    // the original session (which has its own file), so skip them instead of counting them twice.
    if (type === 'assistant' || type === 'user' || type === 'system') {
      const sid = str(rec.sessionId);
      if (sid && sid !== ownId) { diag.replayedRecords = (diag.replayedRecords ?? 0) + 1; continue; }
    }

    const ts = parseTime(rec.timestamp);
    if (!subagent) {
      s.projectDir ??= str(rec.cwd);
      s.gitBranch ??= str(rec.gitBranch) || undefined;
      s.cliVersion ??= str(rec.version);
    }

    // Only conversation records define the session's time span; bookkeeping records
    // (e.g. file-history snapshots) can be written much later on resume.
    const isConversational = type === 'assistant' || type === 'user' || type === 'system';
    if (ts && isConversational) {
      s.eventTimes.push(ts);
      if (!s.startTime || ts < s.startTime) s.startTime = ts;
      if (!s.endTime || ts > s.endTime) s.endTime = ts;
    }

    if (type === 'assistant') {
      const msg = isObj(rec.message) ? rec.message : undefined;
      if (!msg) { diag.warnings.push(`line ${line.lineNo}: assistant record without message`); continue; }
      const model = str(msg.model);
      const synthetic = model === '<synthetic>';
      if (model && !synthetic) st.models.add(model);
      const id = str(msg.id) ?? str(rec.requestId) ?? `line:${file}:${line.lineNo}`;
      if (isObj(msg.usage) && !synthetic) {
        // De-duplicate: later records for the same message id replace earlier ones
        // (they carry the same or more complete usage).
        st.usageByMsg.set(id, usageFrom(msg.usage, model, ts, subagent));
      }
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const block of content) {
        if (!isObj(block) || block.type !== 'tool_use') continue;
        const callId = str(block.id);
        if (!callId || st.calls.has(callId)) continue;
        const name = str(block.name) ?? 'unknown';
        const d = describeInput(name, block.input);
        st.calls.set(callId, { id: callId, name, timestamp: ts, status: 'unknown', ...d, subagent: subagent || undefined });
      }
      if (!subagent && ts && str(msg.stop_reason) === 'end_turn') s.boundaries.push({ timestamp: ts, kind: 'assistant-end' });
    } else if (type === 'user') {
      const msg = isObj(rec.message) ? rec.message : undefined;
      if (!msg) continue;
      const content = msg.content;
      const blocks = Array.isArray(content) ? content : [];
      const results = blocks.filter(b => isObj(b) && b.type === 'tool_result') as Record<string, unknown>[];
      if (results.length) {
        const tur = isObj(rec.toolUseResult) ? rec.toolUseResult : undefined;
        for (const r of results) {
          const call = st.calls.get(str(r.tool_use_id) ?? '');
          if (!call) { inc(diag.unknownTypeCounts, 'tool_result(without matching tool_use)'); continue; }
          call.resultTimestamp = ts;
          const text = textOf(r.content);
          const interrupted = (tur && tur.interrupted === true) || /\[Request interrupted by user/.test(text);
          if (interrupted) {
            call.status = 'interrupted';
          } else if (r.is_error === true) {
            call.status = 'error';
            call.exitCode = exitCodeFromText(text);
            call.errorClass = classifyError(text, call.exitCode);
            call.errorSignature = errorSignature(text);
            call.errorSnippet = errorSnippet(text);
          } else {
            call.status = 'success';
          }
          const measured = tur ? (num(tur.durationMs) ?? num(tur.totalDurationMs)) : undefined;
          if (measured !== undefined && results.length === 1) {
            call.durationMs = measured; call.durationSource = 'measured';
          } else if (call.timestamp && ts) {
            call.durationMs = Math.max(0, ts.getTime() - call.timestamp.getTime());
            call.durationSource = 'log-interval';
          }
        }
      } else if (!subagent && rec.isMeta !== true && ts) {
        const text = textOf(content);
        if (/^\[Request interrupted by user/.test(text)) {
          s.interruptions++;
          s.boundaries.push({ timestamp: ts, kind: 'interrupt' });
        } else if (text.trim()) {
          s.boundaries.push({ timestamp: ts, kind: 'user-prompt' });
        }
      }
    } else if (type === 'system') {
      const sub = str(rec.subtype);
      if (sub === 'api_error') { s.apiErrors++; if (ts && !subagent) s.boundaries.push({ timestamp: ts, kind: 'api-error' }); }
      if (sub === 'compact_boundary' && ts && !subagent) s.boundaries.push({ timestamp: ts, kind: 'compaction' });
    }
  }
  if (diag.replayedRecords) {
    diag.warnings.push(`${diag.replayedRecords} conversation record(s) replayed from other sessions (resumed history) were excluded; they are counted in their original sessions`);
  }
  if (lastWasMalformed) {
    diag.truncatedTail = true;
    diag.warnings.push('last line is not valid JSON (file may still be being written)');
  }
}

/** Parse one Claude Code session (main transcript plus any subagent transcripts). */
export async function parseClaudeSession(sessionId: string, mainFile: string | undefined, subagentFiles: string[] = []): Promise<NormalizedSession> {
  const st: State = {
    session: {
      agent: 'claude-code', sessionId, files: [], models: [], usage: [], usageAvailable: false,
      toolCalls: [], boundaries: [], eventTimes: [], apiErrors: 0, interruptions: 0, diagnostics: [],
    },
    usageByMsg: new Map(), calls: new Map(), models: new Set(),
  };
  // Records carry the ID of the session they were written in. The main file's name is that ID.
  const ownId = mainFile ? path.basename(mainFile, '.jsonl') : sessionId;
  if (mainFile) { st.session.files.push(mainFile); await parseFile(mainFile, st, false, ownId); }
  for (const f of subagentFiles) { st.session.files.push(f); await parseFile(f, st, true, ownId); }

  const s = st.session;
  s.usage = [...st.usageByMsg.values()];
  s.usageAvailable = s.usage.length > 0;
  s.models = [...st.models];
  s.toolCalls = [...st.calls.values()].sort((a, b) => (a.timestamp?.getTime() ?? 0) - (b.timestamp?.getTime() ?? 0));
  s.eventTimes.sort((a, b) => a.getTime() - b.getTime());
  s.boundaries.sort((a: TurnBoundary, b: TurnBoundary) => a.timestamp.getTime() - b.timestamp.getTime());
  return s;
}
