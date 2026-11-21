# AgentTrace plugin for Claude Code

Adds the AgentTrace MCP server and a skill that explains your local Claude Code and Codex sessions: tokens, estimated API-equivalent cost, time, tool errors, repeated failures and possible loops. Everything runs locally. No cloud service and no LLM API.

Requires **Node.js 22 or newer** and Claude Code with plugin support.

## Try it locally

From the AgentTrace repository root:

```bash
claude --plugin-dir ./plugins/agenttrace
```

This loads the plugin for that session only and changes none of your saved configuration.

## Use it

A plugin skill is namespaced, so the command is:

```
/agenttrace:agenttrace
/agenttrace:agenttrace latest
/agenttrace:agenttrace sessions
/agenttrace:agenttrace failures
/agenttrace:agenttrace costs
/agenttrace:agenttrace weekly
```

Want the short `/agenttrace` instead? Install the standalone skill (see the main README), which gives the exact name without a namespace.

The plugin starts the MCP server `agenttrace`, pinned to `@vukkisa/agenttrace@0.3.0`. Its tools appear as `mcp__plugin_agenttrace_agenttrace__*`. Bump the pin in `.mcp.json` when a new AgentTrace version is released.

## Avoid duplicate servers

If you already registered AgentTrace yourself (`claude mcp add agenttrace ...`), enabling this plugin starts a second server with the same four tools. Pick one:

- **Keep your manual registration:** use the standalone `/agenttrace` skill and don't enable the plugin.
- **Use the plugin:** remove the manual one with `claude mcp remove agenttrace` (add `--scope user` if you registered it at user scope).

## Remove

```bash
claude plugin uninstall agenttrace
```

If you only used `--plugin-dir`, just start Claude Code without that flag.

## Privacy

The skill uses only the summaries returned by the AgentTrace tools. It never asks for transcripts, prompts, assistant messages or tool output, never shows absolute paths, and keeps command text off unless you ask for it. Costs are estimated API-equivalent figures, not your bill.
