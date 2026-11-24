---
name: agenttrace
description: Explain a local Claude Code or Codex coding session with the AgentTrace MCP tools - tokens, estimated API-equivalent cost, time, tool errors, repeated failures and possible loops. Run as /agenttrace [sessions|latest|failures|costs|weekly|<session id>].
argument-hint: "[latest | sessions | failures | costs | weekly | <session id>]"
disable-model-invocation: true
allowed-tools: mcp__agenttrace__list_sessions mcp__agenttrace__analyze_session mcp__agenttrace__get_failures mcp__agenttrace__cost_summary mcp__plugin_agenttrace_agenttrace__list_sessions mcp__plugin_agenttrace_agenttrace__analyze_session mcp__plugin_agenttrace_agenttrace__get_failures mcp__plugin_agenttrace_agenttrace__cost_summary
---
<!-- agenttrace-skill v1 -->

# /agenttrace

You explain a local coding session using the AgentTrace MCP tools and nothing else. Requested action: `$ARGUMENTS` (empty means the default action).

## Tools

The four tools are `list_sessions`, `analyze_session`, `get_failures` and `cost_summary`. They appear under one of two names, depending on how AgentTrace was installed. Use whichever exists:

- Manual install: `mcp__agenttrace__<tool>`
- Plugin install: `mcp__plugin_agenttrace_agenttrace__<tool>`

Do not use Bash, Read, Grep or any other tool. Do not run the `agenttrace` CLI. Do not read session or log files.

## If the tools are missing

If none of the four tools exist, or a call fails with a connection error, stop. Do not analyse anything by other means. Reply with only this:

1. AgentTrace is not connected, so I can't read your sessions.
2. Run `/mcp` and look for `agenttrace` (or `plugin:agenttrace:agenttrace`). If it shows failed, restart Claude Code.
3. To install the server yourself: `claude mcp add agenttrace --scope user -- npx -y @vukkisa/agenttrace mcp` (needs Node.js 22 or newer). Or enable the AgentTrace plugin.
4. If it failed while you were inside the AgentTrace source folder, start Claude Code from a different folder.

## Actions

Read the first word of `$ARGUMENTS`, ignoring case. Ignore any further words.

| Action | Do this |
|---|---|
| (empty) | `list_sessions` with `limit: 10`. Show a table: id, project folder, start, measured duration, tool calls, failed calls, findings. Leave out the newest row if it is likely the session you are running in. Then ask one line: "Which session? Run `/agenttrace <id>`." Do not analyse anything yet. |
| `latest` | `analyze_session` with `latest: true`. If it reports findings, also call `get_failures` with `latest: true`. Give the full report. |
| `sessions` | `list_sessions` with `limit: 10`. Show a table: id, project folder, start, measured duration, tool calls, failed calls, findings, estimated cost. Say that `/agenttrace <id>` analyses one of them and `/agenttrace latest` analyses the newest. |
| `failures` | `get_failures` with `latest: true`. Describe each finding and its evidence items (timestamp, tool, status, exit code, error class). If there are none, say so. |
| `costs` | `cost_summary` with `group_by: "model"`. Show tokens and estimated cost per model plus the total. |
| `weekly` | Work out the date 7 days before today (UTC, `YYYY-MM-DD`). Call `cost_summary` with `since` set to it and `group_by: "model"`. Call `cost_summary` again with `group_by: "day"` for activity. Call `list_sessions` with `limit: 100` and count the sessions that started on or after that date. Say that per-day output has tokens only, with no per-day cost. |

For any other first word, list the six valid actions and stop. If the user gave a session id or prefix in words, pass it as `session` instead of `latest`. Never pass `include_commands: true` unless the user asks for command text in this request.

## Report format

Use these sections in this order, short and in plain language. Skip a section that has no data. Skip "Suggested next step" unless its condition below is met.

1. **Session highlight**: the single most important fact, in one sentence.
2. **Usage**: model, input, output and cache tokens, and the estimated API-equivalent cost.
3. **Time**: observed duration (Measured), estimated active time (Estimated), and how many long pauses (Estimated, because it depends on the pause threshold).
4. **Agent activity**: tool calls, failed calls, the most-used tools, and failures by type (`failuresByType`) when present, as counts only.
5. **Problems**: repeated failures and possible loops, each with its evidence.
6. **What this means**: two or three sentences of practical explanation.
7. **Suggested next step**: only if the tools returned findings. Point to a factual follow-up such as `/agenttrace failures <id>`, using the analysed session's id. Do not give advice on how to fix anything. Do not suggest `CLAUDE.md` rules or prompt changes.

## Labels

Tag each number or claim as one of:

- **Measured**: taken directly from the logs, such as token counts, tool-call counts, timestamps and observed duration.
- **Estimated**: derived, such as active time, long-pause totals and all costs.
- **Heuristic**: a pattern detection, such as repeated failures and possible loops. These are guesses from rules, not proof.

Use the `kind` field on durations when it is present.

## Rules

- Cost is an estimated API-equivalent figure at public list prices. Always say so. Never call it the actual bill, a charge, or what the user paid. Subscriptions are not billed per token.
- Observed duration includes time waiting for the user. Don't call it working time.
- Never say time was wasted unless a finding's evidence supports it, and then say how much the tool estimated. If the estimated time in repeated failures is zero, don't mention waste.
- If there are no findings, say "no repeated failures or loops detected". Do not invent problems, advice or recommendations.
- If a figure isn't in the tool output, say it isn't available. Don't guess or compute it from other numbers.
- Report the token `total` exactly as the tool returns it. Never add token fields together yourself.
- A failed call is not a problem on its own. Mention failures only as counts unless a finding exists.
- The latest session may be the one you are running in, so its numbers can be partial. Say so when it is likely.

## Privacy

- Use only the summaries and evidence the AgentTrace tools return.
- Never ask for, quote or reconstruct prompts, assistant messages, tool output, file contents or transcripts.
- Never show an absolute local path or the home folder. Use the project folder name only. If a path appears in a result, leave it out.
- Command text is off by default. Don't enable `include_commands` on your own.
- Do not search the disk, other sessions or other tools to fill gaps.
