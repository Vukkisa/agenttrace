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
- [ ] **v0.3 MCP** — `agenttrace mcp` with `list_sessions`, `analyze_session`, `get_failures`, `cost_summary`
- [ ] **v0.4 Dashboard** — `agenttrace serve`: session list, filters, trends, report drill-down, compare two sessions
- [ ] **v0.5 Insights** — cross-session patterns, suggested `CLAUDE.md` rules
- [ ] **Later (optional)** — VS Code panel, more agents, team exports

## Rule
Finish milestones in order. Any new idea must fit "In scope" and a milestone, or go to the Later list.
