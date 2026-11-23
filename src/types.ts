/**
 * Normalized data model shared by all parsers and analytics.
 * Parsers translate agent-specific log formats into these types; analytics never
 * read raw log records. Every optional field means "not present in the logs".
 */

export type AgentName = 'claude-code' | 'codex';

/** One token-usage observation, already de-duplicated by the parser. */
export interface UsageRecord {
  timestamp?: Date;
  model?: string;
  /** Input tokens that were NOT served from cache. */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens served from the provider's prompt cache. */
  cacheReadTokens: number;
  /** Tokens written to cache (Claude). Total of 5m + 1h when split is known. */
  cacheWriteTokens: number;
  /** 5-minute cache writes, when the log provides the split. */
  cacheWrite5mTokens?: number;
  /** 1-hour cache writes, when the log provides the split. */
  cacheWrite1hTokens?: number;
  /** Reasoning tokens (Codex). Already included in outputTokens; informational only. */
  reasoningTokens?: number;
  /** How this record was derived. */
  source: 'per-message' | 'cumulative-delta' | 'last-turn';
  /** Provider message id (Claude). Used to avoid counting a message twice across sessions. */
  messageId?: string;
  /** True if the record belongs to a Claude Code subagent transcript. */
  subagent?: boolean;
}

export type ToolStatus = 'success' | 'error' | 'interrupted' | 'unknown';

export interface ToolCall {
  id: string;
  name: string;
  timestamp?: Date;
  /** Timestamp of the record that carried the result. */
  resultTimestamp?: Date;
  status: ToolStatus;
  /** Stable key for identical-input comparison (tool name + normalized input). */
  inputKey: string;
  /** Short, redacted, human-readable summary of the input (command or path). */
  inputSummary: string;
  /** Normalized shell command, when this call ran a command. */
  command?: string;
  /** File paths read by this call. */
  readPaths?: string[];
  /** File paths modified by this call (Edit/Write/apply_patch). */
  modifiedPaths?: string[];
  exitCode?: number;
  /** Normalized error signature (numbers/paths/hex stripped) for grouping. */
  errorSignature?: string;
  /** Short redacted error excerpt. Only shown when the user opts in. */
  errorSnippet?: string;
  /** Error class, e.g. "permission", "not-found", "timeout", "exit-code". */
  errorClass?: string;
  durationMs?: number;
  /**
   * measured: duration reported by the agent itself (e.g. Codex exec duration).
   * log-interval: difference between call and result record timestamps. Includes
   *   approval waits and log write latency; not a precise execution time.
   */
  durationSource?: 'measured' | 'log-interval';
  subagent?: boolean;
}

export interface TurnBoundary {
  timestamp: Date;
  kind: 'user-prompt' | 'assistant-end' | 'interrupt' | 'compaction' | 'api-error';
}

export interface ParserDiagnostics {
  file: string;
  totalLines: number;
  parsedRecords: number;
  malformedLines: number;
  /** True if the last line was not valid JSON (likely a partially written file). */
  truncatedTail: boolean;
  recordTypeCounts: Record<string, number>;
  unknownTypeCounts: Record<string, number>;
  /**
   * Conversation records whose sessionId names a different session. Resuming a Claude Code session
   * copies the earlier history into the new file; those copies belong to the original session and
   * are excluded here so tokens, calls and findings are not counted twice.
   */
  replayedRecords?: number;
  /** Session ids the replayed records belong to (ids only, no paths). */
  replayedFrom?: string[];
  warnings: string[];
}

export interface NormalizedSession {
  agent: AgentName;
  sessionId: string;
  files: string[];
  projectDir?: string;
  gitBranch?: string;
  cliVersion?: string;
  startTime?: Date;
  endTime?: Date;
  models: string[];
  usage: UsageRecord[];
  /** False when the logs carried no token usage at all. */
  usageAvailable: boolean;
  toolCalls: ToolCall[];
  boundaries: TurnBoundary[];
  /** All event timestamps in order, used for gap analysis. */
  eventTimes: Date[];
  apiErrors: number;
  interruptions: number;
  diagnostics: ParserDiagnostics[];
}

/** Lightweight listing entry produced by discovery + a fast header read. */
export interface SessionRef {
  agent: AgentName;
  sessionId: string;
  files: string[];
  mtime: Date;
  sizeBytes: number;
}
