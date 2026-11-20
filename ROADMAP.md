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
  - [x] CI workflow written (not yet run on GitHub — needs push)
  - [x] summary cache: `analyze --all` 7.0 s → ~0.25 s warm
  - [x] package ready (`npm pack` + install + npx tested)
  - [~] Codex real validation: 1 real session only, no token/tool events available
  - [ ] decide npm name (`agenttrace` likely blocked by `agent-trace`), push to GitHub, publish
- [ ] **v0.3 MCP** — `agenttrace mcp` with `list_sessions`, `analyze_session`, `get_failures`, `cost_summary`
- [ ] **v0.4 Dashboard** — `agenttrace serve`: session list, filters, trends, report drill-down, compare two sessions
- [ ] **v0.5 Insights** — cross-session patterns, suggested `CLAUDE.md` rules
- [ ] **Later (optional)** — VS Code panel, more agents, team exports

## Rule
Finish milestones in order. Any new idea must fit "In scope" and a milestone, or go to the Later list.
