# AgentTrace Roadmap

**Mission:** Explain what an AI coding agent did in a session — cost, time, failures, loops. Local, offline, no LLM.

## In scope
- Claude Code + Codex session logs
- Tokens, API-equivalent cost, time, tool usage
- Repeated failures + possible loops, always with evidence
- Privacy-safe shareable reports

## Out of scope
- Real-time monitoring, cloud sync, actual billing
- Judging code quality
- Other agents (Cursor, Aider…) until there is demand

## Milestones
- [x] **v0.1 Core** — engine, CLI, HTML report, 43 tests, verified on real sessions
- [ ] **v0.2 Shippable** — git repo, CI, npm publish (`npx agenttrace`), cache for fast `--all`, validate Codex on real logs
  - [x] git repo + .gitignore
  - [x] CI workflow written and passing on GitHub (4 jobs, green on `aecf2e5`)
  - [x] summary cache: `analyze --all` 7.0 s → ~0.25 s warm
  - [x] package ready (`npm pack` + install + npx tested)
  - [x] accuracy check on real sessions: fixed double counting of resumed sessions, permission-error window, weak-loop rule
  - [~] Codex real validation: 1 real session only, no token/tool events available
  - [x] npm name `@vukkisa/agenttrace` chosen, pushed to GitHub, published as 0.2.0 (verified with `npx`)
- [ ] **v0.3 MCP** — `agenttrace mcp`: lets Claude Code (or any MCP client) query local session analysis in chat. Implemented (official `@modelcontextprotocol/server` v2, stdio); 89 tests pass; all four tools tried in a real Claude Code client; committed and versioned 0.3.0; not yet pushed or published.
  - Tools (all read-only):
    1. `list_sessions`
    2. `analyze_session`
    3. `get_failures`
    4. `cost_summary`
  - Rules:
    - Runs locally. No cloud service and no LLM API needed by AgentTrace.
    - Returns only summaries and supporting evidence (counts, timestamps, tool names, error signatures), never raw transcript contents.
    - Costs are estimated API-equivalent costs, not actual subscription bills.
    - Time values must say whether they are measured durations or estimates.
    - No per-operation token breakdown unless separately implemented and validated.
    - Automated improvement suggestions and `CLAUDE.md` recommendations stay in v0.5.
- [ ] **v0.4 Dashboard** — `agenttrace serve`: session list, filters, trends, report drill-down, compare two sessions
- [ ] **v0.5 Insights** — cross-session patterns, suggested `CLAUDE.md` rules
- [ ] **Later (optional)** — VS Code panel, more agents, team exports

## Rule
Finish milestones in order. Any new idea must fit "In scope" and a milestone, or go to the Later list.
