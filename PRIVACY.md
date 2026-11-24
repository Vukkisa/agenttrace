# AgentTrace privacy policy

AgentTrace runs entirely on your computer. The author does not receive any of your data.

**What it reads.** Your local Claude Code and Codex session logs, opened read-only. It never writes to `~/.claude`, `~/.codex`, your repositories or agent configuration.

**What it sends.** Nothing. There is no network access, no telemetry, no analytics, no accounts, and no calls to AI or cloud services. No credentials are needed.

**What it outputs.** Metadata, counts, token totals, estimated cost, tool names, timings, and redacted shell commands and file paths. Prompts, assistant text, file contents and tool output are not included. Optional error snippets (`--show-errors`) are the first line of error output, after secret redaction.

**MCP server and plugin.** The MCP server returns summaries and evidence only, and its output becomes part of your conversation with the assistant. Command text is off by default.

**What it stores.** A summary cache in your user cache folder holding per-session counts, token totals, timing, model names, project folder, and each log file's size and modification time. It holds no prompts, commands or tool output. Permissions are `0600`. Disable it with `--no-cache` or delete it with `agenttrace cache clear`. Reports are written only where you choose, with `0600` permissions.

**Third parties.** None. The npm package is installed from the public npm registry by your own package manager; AgentTrace itself makes no requests.

**Changes and contact.** Changes to this policy appear in this file in the repository. Questions or concerns: open an issue at https://github.com/Vukkisa/agenttrace/issues.
