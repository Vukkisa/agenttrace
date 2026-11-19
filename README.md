# AgentTrace

**Understand what happened in your AI coding sessions.** AgentTrace is a local-first CLI that reads the session logs Claude Code and Codex already write on your machine and reports:

- token usage (by session, model and day) and an **API-equivalent cost estimate**
- time spent, long pauses, and tool durations
- tool usage and failed tool calls
- **repeated failures** (same command/test failing again and again)
- **possible repetitive behaviour** (loops), always with evidence

Everything runs offline. Nothing is uploaded, no LLM is used, no API key is needed, and the original logs are never modified.

```
$ agenttrace analyze --latest
...
  REPEATED FAILURE DETECTED  [measured]  Same test command failed repeatedly
    Subject:     pytest tests/test_auth.py
    Occurrences: 6 (5 failed)
    Time range:  Nov 19, 10:32–Nov 19, 10:41 (9m 30s)
    Later success: yes
    Why flagged: The normalized command ran 6 time(s) and returned an error 5 time(s); 1 file modification(s) were recorded in between.
    Recommendation: Inspect the original test failure output before re-running the same test again.
```

See [`examples/example-report.html`](examples/example-report.html) for a full HTML report generated from synthetic data.

## Install

Requires Node.js 20+ (22.15+ to read compressed `.jsonl.zst` Codex logs).

```bash
git clone <this repo> agenttrace && cd agenttrace
npm install
npm run build
npm link        # optional: puts `agenttrace` on your PATH
```

Or run without linking: `node dist/cli/index.js <command>`.

## Usage

| Command | What it does |
|---|---|
| `agenttrace scan` | Show which log directories were found and how many sessions each has |
| `agenttrace sessions [--limit 30] [--json]` | List sessions: agent, ID, start, duration, models |
| `agenttrace analyze --session <id>` | Analyze one session (ID or unique prefix) |
| `agenttrace analyze --latest` | Analyze the most recently modified session |
| `agenttrace analyze --all [--json]` | Totals across all sessions, by model and by day |
| `agenttrace report --session <id> [--out file.html]` | Write an offline HTML report |
| `agenttrace report --latest` | HTML report for the latest session |
| `agenttrace inspect [--session <id>] [--json]` | Parser diagnostics: record-type counts, unsupported records, malformed lines. No content. |
| `agenttrace pricing` | Show the pricing table in use |
| `agenttrace pricing --init my-prices.json` | Write a template for custom prices |
| `agenttrace reports-clean [--dir .] [--yes]` | List / delete generated `agenttrace-report-*.html` files |

Global options: `--claude-dir <path>`, `--codex-dir <path>`, `--pricing <file>`, `--agent claude-code|codex`.

Detection options (`analyze`, `report`): `--threshold <n>` (default 3), `--pause-minutes <n>` (default 5), `--show-errors` (include redacted first-line error excerpts; off by default).

### Where logs are found

- **Claude Code:** `--claude-dir`, else every dir in `$CLAUDE_CONFIG_DIR` (comma-separated), `~/.claude`, `~/.config/claude`. Reads `projects/<project>/<session-id>.jsonl` plus subagent transcripts in `projects/<project>/<session-id>/subagents/*.jsonl` (counted as part of the parent session).
- **Codex:** `--codex-dir`, else `$CODEX_HOME`, else `~/.codex`. Reads `sessions/**/rollout-*.jsonl` (and `.jsonl.zst`) plus `archived_sessions/`.

## What is measured vs estimated

Every number in the reports is labelled.

| Metric | Basis | Notes |
|---|---|---|
| Token counts | **measured** | Read from the logs. Claude: one API response is split over several records sharing `message.id`, so usage is de-duplicated by message ID. Codex: `token_count` events carry *cumulative* totals that are often repeated, so AgentTrace uses deltas between successive totals and never sums snapshots. |
| Tool calls, failures, exit codes | **measured** | Claude: `tool_result.is_error`; Codex: exit codes from `exec_command_end` / tool output metadata, `patch_apply_end.success`. |
| Session start/end, duration, pauses | **measured** from timestamps | Duration = last − first conversation event. "Active" excludes gaps over the pause threshold. |
| Tool duration "measured by agent" | **measured** | Codex exec durations; Claude `durationMs` where present. |
| Tool duration "call→result interval" | **observed** | Time between the call and result records. Includes approval waits; not exact execution time. |
| Time-by-category | **estimated** | Gaps between events attributed to the activity in progress. |
| API-equivalent cost | **estimated** | Tokens × list price. Not your bill (see below). |
| Repeated failures | **measured** counts | Grouping is deterministic: normalized commands (`cd x &&`, `2>&1`, `\| tail -n N` stripped), identical inputs, normalized error signatures. |
| Possible loops, repeated reads, similar errors | **heuristic** | Patterns in the logs, not proof the agent was stuck. |
| "Time in repeated-failure periods" | **estimated** | Union of back-to-back repetition periods (gaps ≤ 10 min). |

## Cost: what it is and isn't

**API-equivalent cost** = what these tokens would cost at public API list prices. It is **not** what you were charged:

- Subscription plans (Claude Pro/Max, ChatGPT plans) are not billed per token.
- Actual provider billing can differ (discounts, batch/priority tiers, regions, rounding).

Rules AgentTrace follows:

- A model is priced only if it matches a pricing entry **exactly** (or an alias, or the same ID with a `-YYYYMMDD` suffix). No fuzzy matching.
- If any token category used (e.g. cache reads) has no price, that model's cost is **not available**, not guessed.
- Unknown models are listed; totals are marked **partial** when some models lack prices.

### Custom prices (proxies such as OmniRoute, or newer models)

```bash
agenttrace pricing --init my-prices.json   # edit it
agenttrace analyze --latest --pricing my-prices.json
```

`~/.agenttrace/pricing.json` is also read automatically if it exists (AgentTrace never creates it). Entries:

```json
{ "models": [ {
  "model": "my-proxy/claude-sonnet", "aliases": [],
  "inputPerMTok": 3, "outputPerMTok": 15, "cacheReadPerMTok": 0.3,
  "cacheWrite5mPerMTok": 3.75, "cacheWrite1hPerMTok": 6,
  "source": "provider price sheet", "lastUpdated": "2026-11-19"
} ] }
```

Built-in prices (with source and date) are in [`src/pricing/defaults.ts`](src/pricing/defaults.ts). Some cache prices are **derived** from documented multipliers and say so in their notes. Codex models newer than `gpt-5` / `gpt-5-mini` are deliberately not included: add them with `--pricing`.

## Privacy

- Logs are opened read-only. AgentTrace never writes to `~/.claude`, `~/.codex`, repositories or any configuration.
- No network access, no telemetry, no LLM calls, no credentials required.
- Reports contain metadata, counts, tool names, **redacted** shell commands and file paths. Prompts, assistant text, file contents and tool output are **not** included.
- `--show-errors` adds the first line of error output, after secret redaction (API keys, tokens, JWTs, private keys, `password=`-style values, credentials in URLs).
- Reports are written only where you choose (`--out`, default: current directory) with `0600` permissions. Remove them with `agenttrace reports-clean --yes` or `rm`.

## How detection works (v0.1)

All deterministic; threshold default 3 (`--threshold`).

- **Repeated failed command / test:** same normalized command returns an error ≥ threshold times. Reports whether it later succeeded and how many file modifications happened between the first and last failure.
- **Identical failed retry:** same tool with byte-identical input errors ≥ threshold times.
- **Repeated permission errors:** permission / sandbox / user-denial errors ≥ threshold times for one tool.
- **Similar errors:** same normalized error signature ≥ threshold times within 10 minutes across *different* inputs.
- **Repeated reads:** the same read ≥ threshold times with no recorded modification of that file and no context compaction in between. Flagged as possibly legitimate.
- **Possible loops:** (a) the same 1–3 call sequence (same tool, input and outcome) repeated back-to-back ≥ threshold times; successful read-only polling needs 2× threshold. (b) A failing command re-run ≥ threshold times with no Edit/Write/patch in between.

## Supported formats

| Agent | Format | Status |
|---|---|---|
| Claude Code | `projects/*/<id>.jsonl` (`assistant`, `user`, `system`, plus ~20 bookkeeping types) | Supported; verified read-only against 170+ local sessions (CLI v2.1.x) |
| Claude Code | Subagent transcripts `<id>/subagents/agent-*.jsonl` | Supported |
| Codex CLI | `{timestamp,type,payload}` rollouts (`session_meta`, `turn_context`, `response_item`, `event_msg`, `compacted`) | Supported; built from documented/observed structure and synthetic fixtures (see limitations) |
| Codex CLI | Legacy early-2025 rollouts (bare response items) | Supported (no per-item timestamps) |
| Codex CLI | `.jsonl.zst` | Supported on Node ≥ 22.15 (built-in zlib zstd); skipped with a note otherwise |

Unknown record types are counted and shown by `agenttrace inspect`; they never stop a scan.

## Known limitations

- **Codex coverage was tested mainly on synthetic fixtures.** The machine this was built on had a single, short Codex session with no tool calls or token events. Codex event names and payloads change between versions; run `agenttrace inspect --agent codex` and open an issue with the (content-free) record-type counts if something is unsupported.
- Log formats are undocumented and may change without notice.
- File modifications made via shell commands (`sed -i`, codegen, formatters) or outside the agent are invisible, so "no file changes between retries" means "none recorded by the agent's edit tools".
- Claude Code tool durations are call→result intervals (include approval waits) unless the log records a duration.
- Subagent token usage is included in the parent session. Subagent tool calls are excluded from the timeline and main-sequence loop detection (analyzed separately).
- Sessions resumed into new files appear as separate sessions.
- `sessions` and `analyze --all` parse every file; very large histories take a few seconds (≈7 s for 173 sessions / 240k records here; no index/cache yet).
- Time-by-category and waste figures are estimates from timestamps.

## Development

```bash
npm install
npm test              # vitest, synthetic fixtures only
npm run typecheck
npm run fixtures      # regenerate tests/fixtures from tests/fixtures/generate.mjs
npm run example       # rebuild examples/example-report.html
```

Layout:

```
src/
  cli/            commander CLI
  discovery/      log directory discovery
  parsers/        jsonl reader, normalization, claude/, codex/
  analytics/      tokens/, costs/, timing/, failures/, loops/, analyze.ts
  pricing/        pricing table + defaults
  privacy/        redaction
  reports/        text + offline HTML
tests/            parsers/, analytics/, reports/, fixtures/ (synthetic)
```

`analyzeSession()` is a pure function over a normalized session, so a future VS Code view or MCP server can reuse it directly.

## License

MIT
