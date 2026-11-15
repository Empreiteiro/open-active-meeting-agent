# Connecting other agents and IDEs

open-meeting-agent is an MCP server over stdio: `node <repo>/dist/oma.mjs mcp`.
Any client that speaks MCP can use it. Replace `/ABS/PATH` with where you cloned
the repo. Settings go in `~/.open-meeting-agent/config.json` (or `env` in each
client's config).

The tools are the same everywhere; the Claude Code plugin adds skills that
drive the flow (join → plan → work). Elsewhere, the MCP prompt `work_on_meeting`
and the server's instructions describe the same flow.

> Config formats change. These were current when written; check your client's
> MCP docs if one doesn't load.

## Claude Code — plugin (recommended)

```bash
claude plugin marketplace add /ABS/PATH/open-meeting-agent
claude plugin install meeting-agent@open-meeting-agent
```

Skills: `/meeting-agent:join-meeting <link>`, `/meeting-agent:live-meeting`
(Claude Code answers in the meeting), `/meeting-agent:plan-meeting`,
`/meeting-agent:work-on-meeting`, `/meeting-agent:meeting-agent-setup`.

## Claude Code — MCP only

```bash
claude mcp add --transport stdio --scope user meeting-agent -- node /ABS/PATH/open-meeting-agent/dist/oma.mjs mcp
```

## Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "meeting-agent": { "command": "node", "args": ["/ABS/PATH/open-meeting-agent/dist/oma.mjs", "mcp"] }
  }
}
```

## Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "meeting-agent": { "command": "node", "args": ["/ABS/PATH/open-meeting-agent/dist/oma.mjs", "mcp"] }
  }
}
```

## VS Code (Copilot agent mode)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "meeting-agent": { "type": "stdio", "command": "node", "args": ["/ABS/PATH/open-meeting-agent/dist/oma.mjs", "mcp"] }
  }
}
```

## Windsurf

`~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "meeting-agent": { "command": "node", "args": ["/ABS/PATH/open-meeting-agent/dist/oma.mjs", "mcp"] }
  }
}
```

## Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.meeting-agent]
command = "node"
args = ["/ABS/PATH/open-meeting-agent/dist/oma.mjs", "mcp"]
```

## Gemini CLI

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "meeting-agent": { "command": "node", "args": ["/ABS/PATH/open-meeting-agent/dist/oma.mjs", "mcp"] }
  }
}
```

## The agent acting on its own after the meeting

Set `OMA_AGENT_COMMAND` and, when a call is ready, open-meeting-agent starts
your coding agent in the call's work folder with a prompt that hands it the
call (`{prompt}`, `{call_id}` and `{workdir}` are filled in):

| Agent | `OMA_AGENT_COMMAND` |
|---|---|
| Claude Code | `claude -p --permission-mode acceptEdits {prompt}` |
| Codex CLI | `codex exec --full-auto {prompt}` |
| Gemini CLI | `gemini -p {prompt} --yolo` |
| anything else | any command; `{prompt}` is shell-quoted |

What it is asked to do follows the call's autonomy: `suggest` builds the plan
and stops, `issues` also opens the issues, `prs` also does the tasks and opens
the pull requests. The agent's output goes to `agent.log` in the call folder.
Give it only the permissions you are comfortable with for unattended work.
