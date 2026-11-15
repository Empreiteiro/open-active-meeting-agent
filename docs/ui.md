# The web UI

```bash
make ui        # or: oma ui [--port 4141] [--no-open]
```

It opens `http://127.0.0.1:4141`: a chat in the style of ChatGPT with your
**local agent** — Claude Code by default, with its own sign-in, so no API key —
beside your meetings.

- **The sidebar**: a new chat, *Join a meeting*, your **meetings** (a dot for
  where each one is: joining, in the meeting, processing, ready to plan,
  planned), your **chats**, the agent that answers, and *Setup*. ⌘K searches.
- **A chat**: ask anything — "what was agreed in the last meeting?", "build its
  plan", "do the tasks". Paste a Meet / Teams link and the join form opens.
- **A meeting** has three tabs:
  - **Chat** — a chat about this meeting: the agent is told which call it is.
  - **Live** (during the meeting) / **Transcript** (after): what is being said,
    the moments someone called the agent highlighted, a box to write in the
    meeting chat as the agent, *End meeting* / *Leave without keeping*. When
    nobody would answer in the meeting, one click lets Claude Code do it.
  - **Plan** — the tasks (state, priority, links, acceptance criteria, the
    screens from the call), the CRM update, the document, where each was
    delivered; *Deliver* and *Do the tasks*.
- **Setup**: who answers the chat; Claude Code for plans and answers in the
  meeting (one click sets `OMA_LLM_PROVIDER=claude-code`); the defaults for new
  meetings; what is ready on this machine (`oma doctor`). Tokens and keys stay
  in `~/.open-meeting-agent/config.json`.

The page follows the system's light / dark theme and the browser's language
(English, Portuguese; `?lang=pt` forces it).

## Local agents

| Where | Who answers | Settings |
|---|---|---|
| The UI's chat | Claude Code (default) | `OMA_UI_MODEL` (`sonnet`, `haiku`…), `OMA_UI_ALLOWED_TOOLS`, `OMA_UI_WORKDIR` |
| | any command-line agent | `OMA_UI_AGENT=command`, `OMA_UI_AGENT_COMMAND` |
| Plans, and answers in the meeting | Claude Code | `OMA_LLM_PROVIDER=claude-code` (`OMA_LLM_MODEL` optional) |
| | any command-line agent | `OMA_LLM_PROVIDER=command`, `OMA_LLM_COMMAND` |

### Claude Code in the chat

- Each chat is a Claude Code session (`claude -p`), resumed turn after turn —
  it also shows up in `claude --resume`. Its answer streams into the page,
  with each tool it uses.
- It works in the chat's folder (under the input; *Change folder* in the + menu).
  A meeting's chat starts in the call's work folder, others in
  `OMA_UI_WORKDIR` or your home folder.
- The meeting tools are allowed without asking — from the plugin, from
  `claude mcp add meeting-agent`, or, when Claude Code has neither, from the
  MCP server the UI adds for the session. For anything else that needs
  permission (editing a file, running a command), the request shows up in the
  chat: **Allow** or **Deny**. Your Claude Code settings still apply
  (permission rules, default mode); `OMA_UI_ALLOWED_TOOLS` adds rules
  (`Bash(git status:*),Edit`).
- The stop button ends the turn.

### Other agents

Any command that reads the prompt on stdin and answers on stdout — e.g. Codex
(`codex exec -`) or Gemini CLI. Check your agent's own flags for reading the
prompt from stdin and for what it may do without asking; only Claude Code has
been tried here. The chat sends the conversation as text each turn; the
agent's tools are its own (configure the meeting-agent MCP server in it —
[integrations.md](integrations.md)). As the planning model, the screens from
the call go as file paths.

## Safety

The UI drives an agent that can act on this machine, so:

- it listens on `127.0.0.1` only, and refuses requests addressed to any other
  host name (no DNS rebinding);
- every API call carries a token the page receives when it is served: another
  website open in your browser can't drive it;
- changes are JSON only; the settings it can change are the defaults above,
  never tokens or keys;
- Claude Code asks you, in the page, before anything outside the meeting tools
  and its own rules.

Anyone who can use this machine's browser can open it — the same as running
`claude` here.

## Under the hood

`src/ui/server.ts` serves `ui/` (plain HTML, CSS and JavaScript, no build) and
a JSON API; a server-sent event stream tells the page when a call changes and
carries the chat as it is written. `src/ui/chats.ts` keeps the chats
(`~/.open-meeting-agent/ui/chats/<id>.json`) and runs a turn;
`src/agents/claude.ts` speaks Claude Code's stream-json protocol, permission
requests included (`--permission-prompt-tool stdio`); `src/agents/command.ts`
runs any other command.
