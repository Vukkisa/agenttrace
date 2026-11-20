// Generates SYNTHETIC fixtures that mirror the structure of real Claude Code / Codex logs.
// No real transcript content is used. Run: node tests/fixtures/generate.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const T = (hhmmss, day = '2026-11-19') => `${day}T${hhmmss}.000Z`;
const write = (rel, lines, tail = '') => {
  const f = path.join(here, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + (lines.length ? '\n' : '') + tail);
};

// ---------------- Claude Code ----------------
const SID = '11111111-1111-4111-8111-111111111111';
const base = { sessionId: SID, cwd: '/home/dev/demo-app', gitBranch: 'feature/auth', version: '2.1.0', isSidechain: false, userType: 'external' };
let u = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++u).padStart(12, '0')}`;
const usage = (i, o, cr, cw, w1 = 0) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw, cache_creation: { ephemeral_5m_input_tokens: cw - w1, ephemeral_1h_input_tokens: w1 } });
const userPrompt = (ts, text) => ({ ...base, type: 'user', uuid: uuid(), timestamp: T(ts), message: { role: 'user', content: text } });
// An assistant API response split into one record per content block, sharing message.id + usage.
const assistant = (ts, id, model, blocks, us, stop = 'tool_use') => blocks.map(b => ({
  ...base, type: 'assistant', uuid: uuid(), timestamp: T(ts), requestId: 'req_' + id,
  message: { id, type: 'message', role: 'assistant', model, content: [b], stop_reason: stop, usage: us },
}));
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const toolResult = (ts, id, content, isError, extra = {}) => ({
  ...base, type: 'user', uuid: uuid(), timestamp: T(ts),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
  toolUseResult: { stdout: '', stderr: '', interrupted: false, ...extra },
});
const PYTEST = 'cd /home/dev/demo-app && pytest tests/test_auth.py 2>&1 | tail -20';
const FAIL = 'Exit code 1\nFAILED tests/test_auth.py::test_login - AssertionError: expected 200, got 401';

const claude = [
  { type: 'permission-mode', permissionMode: 'default', sessionId: SID },
  userPrompt('10:30:00', 'Fix the failing login test'),
  ...assistant('10:30:20', 'msg_01', 'claude-sonnet-5-5', [{ type: 'thinking', thinking: '', signature: 'x' }, toolUse('tu_read1', 'Read', { file_path: '/home/dev/demo-app/src/auth.py' })], usage(10, 50, 20000, 5000, 1000)),
  toolResult('10:30:21', 'tu_read1', 'file contents', false),
  ...assistant('10:31:00', 'msg_02', 'claude-sonnet-5-5', [toolUse('tu_read2', 'Read', { file_path: '/home/dev/demo-app/src/auth.py' })], usage(5, 40, 25000, 100)),
  toolResult('10:31:01', 'tu_read2', 'file contents', false),
  ...assistant('10:32:00', 'msg_03', 'claude-sonnet-5-5', [toolUse('tu_t1', 'Bash', { command: PYTEST, description: 'run tests' })], usage(5, 60, 26000, 200)),
  toolResult('10:32:30', 'tu_t1', FAIL, true),
  'this line is {not valid json',
  ...assistant('10:34:00', 'msg_04', 'claude-sonnet-5-5', [toolUse('tu_t2', 'Bash', { command: PYTEST })], usage(5, 30, 27000, 200)),
  toolResult('10:34:30', 'tu_t2', FAIL, true),
  ...assistant('10:36:00', 'msg_05', 'claude-sonnet-5-5', [toolUse('tu_t3', 'Bash', { command: 'pytest tests/test_auth.py' })], usage(5, 30, 28000, 200)),
  toolResult('10:36:30', 'tu_t3', FAIL, true),
  { type: 'future-record-type', timestamp: T('10:36:40'), data: { anything: true } },
  ...assistant('10:37:00', 'msg_06', 'claude-opus-5-5', [toolUse('tu_edit', 'Edit', { file_path: '/home/dev/demo-app/src/auth.py', old_string: 'a', new_string: 'b' })], usage(5, 300, 30000, 2000)),
  toolResult('10:37:05', 'tu_edit', 'The file has been updated.', false),
  ...assistant('10:39:00', 'msg_07', 'claude-sonnet-5-5', [toolUse('tu_t4', 'Bash', { command: PYTEST })], usage(5, 30, 31000, 200)),
  toolResult('10:39:30', 'tu_t4', FAIL, true),
  ...assistant('10:41:00', 'msg_08', 'claude-sonnet-5-5', [toolUse('tu_t5', 'Bash', { command: PYTEST })], usage(5, 30, 32000, 200)),
  toolResult('10:41:30', 'tu_t5', FAIL, true),
  ...assistant('10:42:00', 'msg_09', 'claude-sonnet-5-5', [toolUse('tu_read3', 'Read', { file_path: '/home/dev/demo-app/src/auth.py' })], usage(5, 20, 33000, 100)),
  toolResult('10:42:01', 'tu_read3', 'file contents', false),
  ...assistant('10:42:30', 'msg_10', 'claude-sonnet-5-5', [toolUse('tu_read4', 'Read', { file_path: '/home/dev/demo-app/src/auth.py' })], usage(5, 20, 33500, 100)),
  toolResult('10:42:31', 'tu_read4', 'file contents', false),
  ...assistant('10:42:45', 'msg_10b', 'claude-sonnet-5-5', [toolUse('tu_read5', 'Read', { file_path: '/home/dev/demo-app/src/auth.py' })], usage(5, 20, 33600, 100)),
  toolResult('10:42:46', 'tu_read5', 'file contents', false),
  ...assistant('10:43:00', 'msg_11', 'claude-sonnet-5-5', [toolUse('tu_t6', 'Bash', { command: PYTEST })], usage(5, 30, 34000, 200)),
  toolResult('10:43:20', 'tu_t6', '5 passed in 0.4s', false),
  { ...base, type: 'system', subtype: 'api_error', uuid: uuid(), timestamp: T('10:43:40'), level: 'error' },
  ...assistant('10:44:00', 'msg_12', 'claude-sonnet-5-5', [toolUse('tu_int', 'Bash', { command: 'npm run dev' })], usage(5, 20, 34500, 100)),
  toolResult('10:44:30', 'tu_int', '[Request interrupted by user for tool use]', true, { interrupted: true }),
  { ...base, type: 'assistant', uuid: uuid(), message: { id: 'msg_nots', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: usage(1, 10, 100, 0) } },
  userPrompt('11:00:00', 'Thanks, also update the docs'),
  ...assistant('11:00:30', 'msg_13', 'claude-sonnet-5-5', [{ type: 'text', text: 'Done.' }], usage(5, 100, 35000, 300), 'end_turn'),
];
// Partially written final line (file still being written).
write(`claude/projects/-home-dev-demo-app/${SID}.jsonl`, claude, '{"type":"assistant","message":{"id":"msg_partial"');

write(`claude/projects/-home-dev-demo-app/${SID}/subagents/agent-a1b2c3.jsonl`, [
  ...assistant('10:33:00', 'msg_sub1', 'claude-haiku-5-5', [toolUse('tu_sub1', 'Grep', { pattern: 'def login', path: '/home/dev/demo-app' })], usage(3, 25, 1000, 500)).map(r => ({ ...r, isSidechain: true, agentId: 'a1b2c3' })),
  { ...toolResult('10:33:02', 'tu_sub1', 'src/auth.py', false), isSidechain: true },
]);

// Empty session and an unknown-model session.
write('claude/projects/-home-dev-other/22222222-2222-4222-8222-222222222222.jsonl', []);
write('claude/projects/-home-dev-other/33333333-3333-4333-8333-333333333333.jsonl', [
  { ...base, sessionId: '33333333-3333-4333-8333-333333333333', type: 'user', uuid: uuid(), timestamp: T('09:00:00'), message: { role: 'user', content: 'hello' } },
  ...assistant('09:00:05', 'msg_u1', 'mystery-model-1', [{ type: 'text', text: 'hi' }], usage(100, 50, 0, 0), 'end_turn').map(r => ({ ...r, sessionId: '33333333-3333-4333-8333-333333333333' })),
]);

// ---------------- Codex (current format) ----------------
const CID = '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const ev = (ts, payload) => ({ timestamp: T(ts), type: 'event_msg', payload });
const item = (ts, payload) => ({ timestamp: T(ts), type: 'response_item', payload });
const tok = (ts, total, last) => ev(ts, { type: 'token_count', info: { total_token_usage: total, last_token_usage: last, model_context_window: 272000 }, rate_limits: null });
const tot = (i, c, o, r) => ({ input_tokens: i, cached_input_tokens: c, output_tokens: o, reasoning_output_tokens: r, total_tokens: i + o });
const shell = (ts, id, script) => item(ts, { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', script], workdir: '/home/dev/api' }), call_id: id });
const out = (ts, id, code, secs) => item(ts, { type: 'function_call_output', call_id: id, output: JSON.stringify({ output: code ? 'npm ERR! Test failed. See above for more details.' : 'ok', metadata: { exit_code: code, duration_seconds: secs } }) });
const execEnd = (ts, id, code, secs) => ev(ts, { type: 'exec_command_end', call_id: id, exit_code: code, duration: { secs, nanos: 500000000 }, aggregated_output: code ? 'npm ERR! Test failed.' : 'ok' });

write(`codex/sessions/2026/11/19/rollout-2026-11-19T12-00-00-${CID}.jsonl`, [
  { timestamp: T('12:00:00'), type: 'session_meta', payload: { id: CID, timestamp: T('12:00:00'), cwd: '/home/dev/api', originator: 'codex_cli_rs', cli_version: '0.60.0', instructions: null, git: { branch: 'fix/tests' } } },
  { timestamp: T('12:00:00'), type: 'turn_context', payload: { cwd: '/home/dev/api', approval_policy: 'on-request', sandbox_policy: { mode: 'workspace-write' }, model: 'gpt-5-codex', effort: 'medium', summary: 'auto' } },
  ev('12:00:01', { type: 'user_message', message: 'make the tests pass', kind: 'plain' }),
  item('12:00:01', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'make the tests pass' }] }),
  tok('12:00:05', tot(1000, 200, 100, 20), tot(1000, 200, 100, 20)),
  tok('12:00:05', tot(1000, 200, 100, 20), tot(1000, 200, 100, 20)), // duplicate snapshot
  shell('12:00:10', 'call_1', 'npm test'), out('12:00:13', 'call_1', 1, 2.5), execEnd('12:00:13', 'call_1', 1, 2),
  shell('12:01:00', 'call_2', 'npm test 2>&1'), out('12:01:03', 'call_2', 1, 2.5), execEnd('12:01:03', 'call_2', 1, 2),
  shell('12:02:00', 'call_3', 'npm test'), out('12:02:03', 'call_3', 1, 2.5), execEnd('12:02:03', 'call_3', 1, 2),
  tok('12:02:10', tot(3000, 1200, 400, 50), tot(2000, 1000, 300, 30)),
  item('12:02:20', { type: 'custom_tool_call', status: 'completed', call_id: 'call_p', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: src/sum.js\n@@\n-a\n+b\n*** End Patch' }),
  item('12:02:21', { type: 'custom_tool_call_output', call_id: 'call_p', output: JSON.stringify({ output: 'Success. Updated the following files:\nM src/sum.js', metadata: { exit_code: 0, duration_seconds: 0 } }) }),
  ev('12:02:21', { type: 'patch_apply_end', call_id: 'call_p', success: true, stdout: 'ok', stderr: '' }),
  { timestamp: T('12:02:30'), type: 'turn_context', payload: { cwd: '/home/dev/api', model: 'gpt-5-mini' } },
  shell('12:02:40', 'call_4', 'npm test'), out('12:02:43', 'call_4', 0, 2.5), execEnd('12:02:43', 'call_4', 0, 2),
  tok('12:02:50', tot(5000, 2000, 600, 60), tot(2000, 800, 200, 10)),
  ev('12:03:00', { type: 'future_event_type', foo: 1 }),
  { timestamp: T('12:03:01'), type: 'mystery_top_level', payload: {} },
  ev('12:03:05', { type: 'task_complete', last_agent_message: 'done' }),
  ev('12:10:00', { type: 'user_message', message: 'run it again', kind: 'plain' }),
  ev('12:10:05', { type: 'turn_aborted', reason: 'interrupted' }),
]);

// ---------------- Codex (legacy early-2025 format, no timestamps on items) ----------------
write('codex/sessions/2025/04/20/rollout-2025-04-20T08-00-00-0196aaaa-0000-7000-8000-000000000001.jsonl', [
  { id: '0196aaaa-0000-7000-8000-000000000001', timestamp: '2025-04-20T08:00:00.000Z', instructions: '' },
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'list files' }] },
  { record_type: 'state' },
  { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['ls', '-la'] }), call_id: 'c1' },
  { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: 'x', metadata: { exit_code: 0, duration_seconds: 0.1 } }) },
]);

// ---------------- Codex 0.45 VS Code / app-server style (structure mirrors a real rollout) ----------------
// Injected <environment_context> user-role messages must not count as prompts; the turn that only
// carried injected context has no real prompt; UserMessage items arrive as event_msg:item_completed.
{
  const id = '0199bbbb-0000-7000-8000-000000000045';
  const t = s => `2026-11-18T09:00:${s}Z`;
  const env = { type: 'input_text', text: '<environment_context>\n  <cwd>/home/dev/web</cwd>\n</environment_context>' };
  write(`codex/sessions/2026/11/18/rollout-2026-11-18T09-00-00-${id}.jsonl`, [
    { timestamp: t('00.000'), type: 'session_meta', payload: { session_id: id, id, timestamp: t('00.000'), cwd: '/home/dev/web', originator: 'codex_vscode', cli_version: '0.45.0-alpha.5', source: 'vscode', model_provider: 'openai', history_mode: 'full' } },
    { timestamp: t('00.010'), type: 'response_item', payload: { type: 'message', role: 'user', content: [env] } },
    { timestamp: t('00.020'), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<user_instructions>\nbe brief\n</user_instructions>' }] } },
    { timestamp: t('00.030'), type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1', started_at: 1763456400, model_context_window: 272000 } },
    { timestamp: t('00.040'), type: 'event_msg', payload: { type: 'item_completed', thread_id: id, turn_id: 'turn-1', item: { type: 'UserMessage', id: 'item-1', content: [{ type: 'text', text: env.text, text_elements: [] }] }, completed_at_ms: 1763456400040 } },
    { timestamp: t('00.050'), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1', last_agent_message: null, completed_at: 1763456400 } },
    { timestamp: t('01.000'), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'add a dark mode toggle' }] } },
    { timestamp: t('01.010'), type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2', started_at: 1763456401, model_context_window: 272000 } },
    { timestamp: t('01.020'), type: 'event_msg', payload: { type: 'item_completed', thread_id: id, turn_id: 'turn-2', item: { type: 'UserMessage', id: 'item-2', content: [{ type: 'text', text: 'add a dark mode toggle', text_elements: [] }] }, completed_at_ms: 1763456401020 } },
    { timestamp: t('01.030'), type: 'turn_context', payload: { cwd: '/home/dev/web', approval_policy: 'on-request', model: 'gpt-5-codex', effort: 'medium', summary: 'auto' } },
    { timestamp: t('01.040'), type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-2', last_agent_message: null, completed_at: 1763456401 } },
  ]);
}

console.log('fixtures written');
