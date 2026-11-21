/**
 * AgentTrace MCP server (local STDIO only).
 *
 * stdout carries MCP protocol messages and nothing else; every diagnostic goes to stderr.
 * No network, no LLM calls. Exposes four read-only tools over the existing analysis engine.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { VERSION } from '../version.js';
import { analyzeSessionTool, costSummary, getFailures, listSessions, type McpContext } from './tools.js';
import { safeErrorMessage, safeLogMessage } from './sanitize.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const AGENT = z.enum(['claude-code', 'codex']);
const SESSION_ID = z.string().min(1).max(100);

type Result = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

async function run(ctx: McpContext, name: string, fn: () => Promise<object>): Promise<Result> {
  try {
    const out = await fn();
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out as Record<string, unknown> };
  } catch (e) {
    ctx.log(`${name} failed: ${safeLogMessage(e)}`);
    return { content: [{ type: 'text', text: safeErrorMessage(e) }], isError: true };
  }
}

export function createServer(ctx: McpContext): McpServer {
  const server = new McpServer({ name: 'agenttrace', version: VERSION }, { capabilities: { tools: {} } });

  server.registerTool('list_sessions', {
    title: 'List sessions',
    description: 'List recent Claude Code and Codex sessions on this machine with project name, start time, measured duration, models, tool-call and failure counts, and estimated API-equivalent cost. Local and read-only (only AgentTrace\'s own summary cache is written). Returns summaries, never conversation content.',
    inputSchema: z.object({
      agent: AGENT.optional().describe('Only this agent.'),
      limit: z.number().int().min(1).max(100).optional().describe('Max sessions to return (default 20, max 100).'),
      project: z.string().max(200).optional().describe('Only sessions whose project folder name contains this text.'),
    }),
    annotations: READ_ONLY,
  }, args => run(ctx, 'list_sessions', () => listSessions(ctx, args)));

  server.registerTool('analyze_session', {
    title: 'Analyze a session',
    description: 'Analyze one session: tokens, estimated API-equivalent cost, timing (each duration labelled measured or estimated), tool-call stats, and detected repeated-failure / loop findings (at most 20, without evidence or command text). Give "session" (id or unique prefix) or set "latest". Local and read-only. Never returns prompts, assistant text or tool output.',
    inputSchema: z.object({
      session: SESSION_ID.optional().describe('Session id or unique prefix from list_sessions.'),
      latest: z.boolean().optional().describe('Analyze the most recently modified session.'),
    }),
    annotations: READ_ONLY,
  }, args => run(ctx, 'analyze_session', () => analyzeSessionTool(ctx, args)));

  server.registerTool('get_failures', {
    title: 'Get failure evidence',
    description: 'Detailed repeated-failure and loop findings for one session, each with up to 8 evidence items (timestamps, tool name, status, exit code, error class). Command text is omitted unless include_commands is true; then it is redacted, path-shortened and truncated. Give "session" or set "latest". Local and read-only.',
    inputSchema: z.object({
      session: SESSION_ID.optional().describe('Session id or unique prefix from list_sessions.'),
      latest: z.boolean().optional().describe('Use the most recently modified session.'),
      kind: z.enum(['repeated-failed-command', 'repeated-failed-test', 'identical-failed-retry', 'repeated-permission-error', 'similar-errors', 'repeated-read', 'possible-loop']).optional().describe('Only findings of this kind.'),
      include_commands: z.boolean().optional().describe('Opt in to redacted, truncated command text in evidence. Default false.'),
      max_findings: z.number().int().min(1).max(20).optional().describe('Max findings (default and cap 20).'),
    }),
    annotations: READ_ONLY,
  }, args => run(ctx, 'get_failures', () => getFailures(ctx, args)));

  server.registerTool('cost_summary', {
    title: 'Cost summary',
    description: 'Token totals and estimated API-equivalent cost (public list prices; NOT an actual bill, subscriptions are not billed per token) across sessions, grouped by model, day or session. Optional agent filter and "since" date (YYYY-MM-DD). Per-day grouping reports tokens only. Local and read-only.',
    inputSchema: z.object({
      agent: AGENT.optional().describe('Only this agent.'),
      since: z.string().max(10).optional().describe('Only sessions that started on or after this UTC date, YYYY-MM-DD.'),
      group_by: z.enum(['model', 'day', 'session']).optional().describe('Grouping (default model).'),
      limit: z.number().int().min(1).max(50).optional().describe('Max groups returned (default 20, max 50).'),
    }),
    annotations: READ_ONLY,
  }, args => run(ctx, 'cost_summary', () => costSummary(ctx, args)));

  return server;
}

/** Start serving on this process's stdin/stdout. */
export function serveMcp(ctx: McpContext) {
  return serveStdio(() => createServer(ctx), { onerror: e => ctx.log(safeLogMessage(e)) });
}
