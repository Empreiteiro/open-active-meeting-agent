# open-meeting-agent

An agent that **joins your meeting**, watches the screen you share, listens to
what you want done, **answers when you call it during the meeting** — and
**keeps working after the call**: it turns the meeting into a plan of small
tasks (with acceptance criteria and screenshots from the call), delivers it
where your team works — tasks in GitHub, Linear, Jira or ClickUp, the CRM
updated, the meeting document in Notion — and your coding agent carries out
the code: pull requests.

It runs **locally** and plugs into **any MCP client** — Claude Code (as a
plugin), Claude Desktop, Cursor, VS Code, Windsurf, Codex, Gemini CLI.

```
 you share the screen and explain          after the call
 ┌───────────────────────────┐   ┌─────────────────────────────────────────────┐
 │ Google Meet / Teams        │   │ transcript + who spoke + screen frames      │
 │   ▲                        │   │        │                                    │
 │   │ joins as "Meeting      │──▶│        ▼                                    │
 │   │ Agent" (bot container) │   │ plan: tasks · criteria · screens · deps     │
 └───┼───────────────────────┘   │        │  (your agent writes it, or a model)│
     │                            │        ▼                                    │
 meetily (your own recording) ───▶│ issues ─▶ your coding agent ─▶ pull requests │
 any audio/video file ───────────▶└─────────────────────────────────────────────┘
```

## How it works

1. **Into the meeting.** `join_meeting` starts a container with Chromium that
   joins the Google Meet or Teams link under the agent's name, records the call
   and the shared screen (Xvfb + PulseAudio + ffmpeg), and reads who is speaking
   from the meeting's own captions. Someone admits it from the lobby. Or skip
   the bot: record the meeting yourself with [meetily](https://github.com/Zackriya-Solutions/meetily)
   (+ `screen_capture` for the screen) and import it, or import any recording.
2. **In the meeting (optional).** With `act: during` or `both`, it answers in
   the chat when someone says its name or mentions it: replies, takes notes for
   the plan, and creates the tasks people ask for right away — see
   [docs/live.md](docs/live.md).
3. **After the call.** The recording is transcribed locally (whisper.cpp) or by
   any OpenAI-compatible API; each line gets the speaker's name; the moments the
   screen changed are kept as frames (F1, F2…).
4. **The plan.** The call is laid out on one timeline — transcript with each
   frame where it appeared — and becomes an execution plan: small tasks, each
   with what/where, 2–6 acceptance criteria, the frames that show it, the
   repository, `pr` or `issue`, priority and dependencies. **Your connected
   agent writes it** (`get_call_context` → `save_plan`), or a configured model
   does (`build_plan`: Anthropic or any OpenAI-compatible server, Ollama included).
   When the call asks for them, the plan also carries a **CRM update** and the
   **meeting document**.
5. **The outputs.** `distribute_plan` delivers it: the tasks to GitHub issues,
   Linear, Jira or ClickUp; the CRM update to HubSpot; the document to a
   markdown file or Notion; any of them to a webhook (Zapier, Make, n8n) or to
   your connected agent, which uses its own tools (MCP connectors) — see
   [docs/outputs.md](docs/outputs.md).
6. **The work.** `next_task` hands your agent the next ready task
   (dependencies done) with its brief and screens; it implements it, opens the
   PR and `update_task`s it done, which unlocks the tasks that depend on it.

Two settings per call decide how far it goes:

- **`act`** — when it acts: `after` the call (default), `during` it (answers in
  the meeting; afterwards only keeps the plan), or `both`.
- **autonomy** — after the call, without asking: `suggest` (stop at the plan),
  `issues` (also deliver the outputs), `prs` (also do the code and open the
  pull requests).

With `OMA_AGENT_COMMAND` set, your coding agent starts by itself when the call
is ready — see [docs/integrations.md](docs/integrations.md).

## Quick start (macOS)

Requirements: **Node ≥ 22.13**, **ffmpeg**, and — to join meetings — a running
container engine (Docker Desktop, OrbStack, Colima or Podman).

```bash
git clone <this repo> ~/Documents/GitHub/open-meeting-agent
cd ~/Documents/GitHub/open-meeting-agent
make setup      # Homebrew deps, a config file, the bot image, the oma command
make doctor     # what is ready
```

The Makefile also covers transcription, Claude Code and meetings —
see [Make commands](#make-commands-macos). By hand:

```bash
brew install ffmpeg
node dist/oma.mjs doctor        # what is ready
node dist/oma.mjs bot build     # the bot image, once (~3 GB, a few minutes)
```

`dist/oma.mjs` is a self-contained bundle (no `npm install` needed to run).

Transcription for the bot's recordings — pick one in `~/.open-meeting-agent/config.json`:

```json
{ "OMA_WHISPER_MODEL": "/Users/you/models/ggml-large-v3-turbo.bin" }
```

(`brew install whisper-cpp`; meetily's downloaded models work), or an API:

```json
{ "OMA_ASR_API_KEY": "sk-…" }
```

### Claude Code

```bash
claude plugin marketplace add ~/Documents/GitHub/open-meeting-agent
claude plugin install meeting-agent@open-meeting-agent
```

Then, in a project:

```
/meeting-agent:join-meeting https://meet.google.com/abc-defg-hij
… share your screen, explain what you want, end the call …
/meeting-agent:plan-meeting
/meeting-agent:work-on-meeting
```

To have it answer during the meeting: ask for it when joining ("join and help
during the call"), then `/meeting-agent:live-meeting` makes Claude Code its
brain for the call (not needed with a planning model configured).

Other clients: [docs/integrations.md](docs/integrations.md).

### From a terminal

```bash
oma join https://meet.google.com/abc-defg-hij --repo acme/app --autonomy issues
oma join <url> --act both --tasks clickup --crm hubspot --doc notion
oma live                    # what is being said (captions and chat)
oma say <call> "On it."     # post in the meeting chat
oma end                     # the agent leaves; transcript + frames are processed
oma status
oma context                 # the call as your agent reads it
oma plan build              # with a configured planning model
oma deliver                 # tasks platform, CRM, document
oma next                    # the next task's brief
oma task <call> t1 done --pr https://github.com/acme/app/pull/12
```

(`oma` = `node dist/oma.mjs`; `npm link` puts it on your PATH.)

### With meetily

meetily records on your own machine (microphone + system audio) and
transcribes locally; open-meeting-agent reads its database (read-only):

```bash
oma screen start            # optional: record the screen during the meeting
# … the meeting, recorded in meetily …
oma screen stop
oma meetily                 # list meetily meetings
oma meetily <meeting-id>    # import: transcript + notes (+ the screen, matched by time)
```

The microphone becomes "Me" and the system audio "Others"
(`OMA_MEETILY_ME_NAME`, `OMA_MEETILY_OTHERS_NAME`). The desktop app itself is
meetily, linked as a submodule in [`desktop/`](desktop/) — see
[docs/meetily.md](docs/meetily.md).

## Make commands (macOS)

The [Makefile](Makefile) wraps setup and everyday use. Nothing needs sudo.
Settings go to `~/.open-meeting-agent/config.json` (`OMA_HOME=<folder> make …`
for another place). `make help` lists the targets.

### First time

```bash
make setup      # Node + ffmpeg, the config file, a container engine, the bot image, oma on the PATH
make whisper    # local transcription (or an API: make set KV="OMA_ASR_API_KEY=sk-…")
make plugin     # the Claude Code plugin
make doctor     # what is ready
```

`make setup` checks for macOS, Homebrew and Node ≥ 22.13, then runs these
steps (each one also runs on its own):

| Target | What it does |
|---|---|
| `make brew-deps` | installs Node and ffmpeg with Homebrew when they are missing |
| `make config` | creates `config.json` from [config.example.json](config.example.json) (only you can read it); an existing one is kept |
| `make engine` | makes sure a container engine runs: starts OrbStack, Docker Desktop or Colima when installed and waits up to 2 minutes. It installs none: `brew install --cask orbstack` |
| `make bot` | builds the bot's image: once (~3 GB, a few minutes), and again after a change in `bot/` |
| `make link` | links `oma` into Homebrew's `bin` folder (`BIN_DIR=<folder>` for another) |
| `make doctor` | what is ready and what is missing |

### Settings

```bash
make set KV="OMA_ACT=both OMA_TASKS_TARGET=clickup OMA_CRM_TARGET=hubspot"
make set KV="CLICKUP_API_TOKEN=pk_… OMA_CLICKUP_LIST_ID=901…"
make set KV="OMA_CRM_TARGET="      # an empty value removes the key
```

`make set` changes only the keys you name. Values can't contain spaces (edit
`config.json` for those), and tokens typed here stay in your shell history —
editing the file avoids that. The keys are in [Configuration](#configuration).

### Optional

| Target | What it does |
|---|---|
| `make whisper` | installs whisper.cpp, downloads a model to `~/.open-meeting-agent/models` and sets `OMA_WHISPER_MODEL`. `WHISPER_MODEL=large-v3-turbo` by default (~1.6 GB); `small`, `medium`… for others |
| `make auth-google` / `make auth-teams` | opens a browser to sign the bot in to its own account (log in, then press Enter in the terminal); the first run installs the bot's npm dependencies and a Chromium. Saves the session to `~/.open-meeting-agent/auth/` and sets `OMA_BOT_AUTH_GOOGLE` / `OMA_BOT_AUTH_TEAMS`: the bot joins as that account instead of a guest (Teams may give guests no chat) |
| `make plugin` | installs the Claude Code plugin from this folder |
| `make mcp-claude` | adds only the MCP server to Claude Code, without the plugin |

### In a meeting

```bash
make join URL=https://meet.google.com/abc-defg-hij
make join URL=https://meet.google.com/abc-defg-hij ACT=both TASKS=clickup CRM=hubspot DOC=notion AUTONOMY=issues
make join URL=<teams link> REPO=acme/app AUTONOMY=prs
make live                          # what is being said (captions and chat)
make say CALL=<id> TEXT="On it."   # post in the meeting chat
make end                           # the agent leaves; the call is processed
make status
make deliver ONLY=crm              # deliver the outputs now (all, or one)
```

| Variable | Values |
|---|---|
| `URL` | the Google Meet or Teams link (required by `join`) |
| `ACT` | `after` · `during` · `both` — when the agent acts ([docs/live.md](docs/live.md)) |
| `TASKS` | `github` · `linear` · `jira` · `clickup` · `webhook` · `agent` · `none` |
| `CRM` | `hubspot` · `webhook` · `agent` · `none` |
| `DOC` | `file` · `notion` · `webhook` · `agent` · `none` ([docs/outputs.md](docs/outputs.md)) |
| `AUTONOMY` | `suggest` · `issues` · `prs` |
| `REPO` | `owner/repo`, for GitHub issues and pull requests |
| `CALL` | a call id (`oma list`); without it, the latest call (`say` needs it) |
| `ONLY` | `tasks` · `crm` · `doc` |

A variable left out takes the default from `config.json`. `make deliver` sends
only what hasn't been delivered yet: use it with autonomy `suggest`, or after
fixing a target's settings.

### Development

| Target | What it does |
|---|---|
| `make install` | npm dependencies, for the host and the bot |
| `make check` | typecheck, tests, build, and the bot's typecheck — run it before committing |
| `make build` | rebuilds `dist/oma.mjs` (commit it) |

## MCP tools

| Tool | What it does |
|---|---|
| `join_meeting` | the bot joins a Meet/Teams link and records (screen + audio + speakers); `act`, `outputs` |
| `watch_meeting` | what is being said now (caption turns + chat), mentions of the agent flagged; long poll |
| `send_meeting_message` | post in the meeting chat as the agent |
| `end_meeting` / `cancel_meeting` | leave and process / leave and keep nothing |
| `import_meetily` | list meetily meetings, or import one |
| `import_recording` | import an audio/video file |
| `screen_capture` | record this screen (start/stop/status) |
| `list_calls` / `call_status` | the calls and where each one is |
| `get_call_context` | the call on one timeline (transcript + frames as images) + the plan rules |
| `get_frames` | frames by label |
| `save_plan` / `build_plan` / `get_plan` | the plan, written by your agent or by a model |
| `add_note` | the person's answer or correction after the call (goes into the plan) |
| `set_call` | link repositories, change autonomy, `act` (also mid-meeting), `outputs`, work folder, title |
| `distribute_plan` | deliver the outputs: tasks (GitHub, Linear, Jira, ClickUp), CRM (HubSpot), document (file, Notion), webhook, or to your agent |
| `record_output` | record where your agent put the CRM update / document |
| `next_task` / `update_task` | work the plan in dependency order |
| `setup_status` / `build_bot` / `run_agent` | setup, and starting the coding agent |

`call_id` is optional everywhere (the latest call). Prompt: `work_on_meeting`.

## Configuration

Environment variables, or the same keys in `~/.open-meeting-agent/config.json`.

| Variable | Default | |
|---|---|---|
| `OMA_HOME` | `~/.open-meeting-agent` | where calls are stored |
| `OMA_AGENT_NAME` | `Meeting Agent` | name in the meeting |
| `OMA_AUTONOMY` | `suggest` | default autonomy: `suggest` · `issues` · `prs` |
| `OMA_ACT` | `after` | when the agent acts: `after` · `during` · `both` ([docs/live.md](docs/live.md)) |
| `OMA_LIVE_NAMES` | — | other names that call the agent in the meeting (`agente,assistente`) |
| `OMA_LIVE_GREETING` | a short hello | what it posts when it gets in (`{name}`), or `off` |
| `OMA_TASKS_TARGET` | `github` | where tasks go: `github` · `linear` · `jira` · `clickup` · `webhook` · `agent` · `none` ([docs/outputs.md](docs/outputs.md)) |
| `OMA_CRM_TARGET` | — | the CRM update: `hubspot` · `webhook` · `agent` |
| `OMA_DOC_TARGET` | — | the meeting document: `file` · `notion` · `webhook` · `agent` |
| `OMA_DOC_DIR`, `OMA_DOC_TEMPLATE` | call folder, minutes | where `file` documents go; a markdown template the document follows |
| `LINEAR_API_KEY`, `OMA_LINEAR_TEAM` | — | Linear |
| `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `OMA_JIRA_PROJECT`, `OMA_JIRA_ISSUE_TYPE` | —, `Task` | Jira (REST v2) |
| `CLICKUP_API_TOKEN`, `OMA_CLICKUP_LIST_ID` | — | ClickUp |
| `HUBSPOT_TOKEN`, `OMA_HUBSPOT_PIPELINE`, `OMA_HUBSPOT_DEAL_STAGE` | —, `default`, `appointmentscheduled` | HubSpot (private app token) |
| `NOTION_TOKEN`, `OMA_NOTION_PARENT_PAGE_ID` / `OMA_NOTION_DATABASE_ID` | — | Notion |
| `OMA_WEBHOOK_URL`, `OMA_WEBHOOK_SECRET` | — | one webhook for any output; the secret signs the body |
| `OMA_LANGUAGE` | `en` | language of the plan and issues (`pt`, `es`…) |
| `OMA_ASR_LANGUAGE` | detected | the spoken language, when detection gets it wrong |
| `OMA_CONTAINER_ENGINE` | docker, else podman | |
| `OMA_BOT_IMAGE` | `open-meeting-agent-bot:latest` | |
| `OMA_BOT_AUTH_GOOGLE` / `OMA_BOT_AUTH_TEAMS` | — | a signed-in Playwright storageState for the bot (`bot/scripts/login.ts`); without it the bot joins as a guest |
| `OMA_BOT_LOCALE` / `OMA_BOT_TIMEZONE` | `en-US` / yours | |
| `OMA_MAX_MEETING_MINUTES` | `120` | |
| `OMA_WHISPER_MODEL`, `OMA_WHISPER_BIN` | —, `whisper-cli` | local transcription |
| `OMA_ASR_API_KEY`, `OMA_ASR_BASE_URL`, `OMA_ASR_MODEL` | `OPENAI_API_KEY`, OpenAI, `whisper-1` | API transcription (Groq: `https://api.groq.com/openai/v1` + `whisper-large-v3`) |
| `OMA_ASR` | auto | force `whisper-cpp` · `openai` · `none` |
| `OMA_LLM_PROVIDER`, `OMA_LLM_MODEL` | — | optional planning model: `anthropic` or `openai` (any OpenAI-compatible server) |
| `OMA_LLM_BASE_URL`, `OMA_LLM_API_KEY` | — | e.g. Ollama: `http://localhost:11434/v1` |
| `OMA_AGENT_COMMAND` | — | started when a call is ready: `{prompt}` `{call_id}` `{workdir}` |
| `GITHUB_TOKEN` | gh CLI | GitHub issues (tasks target `github`) |
| `OMA_GITHUB_API_URL` | `https://api.github.com` | GitHub Enterprise: `https://<host>/api/v3` |
| `OMA_MEETILY_DB` | meetily's app-data SQLite | |
| `OMA_MAX_FRAMES` | `40` | |
| `OMA_SCREEN_DEVICE` | `Capture screen 0` (macOS) | ffmpeg device for `screen_capture` |

## Where things are

```
~/.open-meeting-agent/calls/<id>/
  call.json         status, source, autonomy, repositories, notes
  transcript.json   segments with speakers
  frames.json  frames/F1.jpg …
  plan.json         the plan: each task's state and links, the CRM update, the document, deliveries
  document.md       the meeting document (doc target "file" without OMA_DOC_DIR)
  bot/              the bot's volume: status.json, control.json, live.jsonl, commands.jsonl,
                    audio.m4a, recording.mp4, timeline.json
  live-state.json   live-watch.json   the agent in the meeting
  log.txt  worker.log  agent.log
```

Nothing leaves your machine except what you configure: the transcription API,
the planning model, the output targets (GitHub, Linear, Jira, ClickUp, HubSpot,
Notion, your webhook), and whatever your coding agent sends.

## Status

Early (0.1). What has been exercised:

- the whole flow through the MCP server with a stand-in container engine,
  transcription, model and GitHub (`npm test`): join → end → transcript with
  speaker names → frames → plan (by the agent, or by a model with the retry for
  empty plans) → issues → tasks in dependency order; cancel; meetily import with
  a screen recording; recordings; the agent in the meeting (caption turns and
  chat from the bot, mentions, the connected agent answering, a model answering
  and creating a ClickUp task live) and the outputs (ClickUp, HubSpot, Notion,
  webhook, agent) against stand-in servers;
- the real bot image: it builds, boots (Xvfb, PulseAudio, Chromium), reports
  through its volume, and cancels;
- the Claude Code plugin: `claude plugin validate` passes, it installs from the
  marketplace and its MCP server connects.

Not yet run here: the bot in a live Google Meet / Teams call (its join and
speaker logic come from Queryable's production bot; the live captions-as-text
and chat selectors are new and untested there), the real Linear / Jira /
ClickUp / HubSpot / Notion APIs, whisper.cpp, and `screen_capture` on macOS
(it needs the Screen Recording permission).

## Development

```bash
npm install
npm run typecheck && npm test
npm run build                # → dist/oma.mjs (commit it: the plugin runs it)
cd bot && npm install && npm run typecheck
```

Or `make install` once, then `make check`.

[docs/architecture.md](docs/architecture.md) explains the pieces.

## Credits

- The meeting bot (`bot/`) and the planning approach are ported from
  [Queryable](https://app.queryable.digital)'s agent calls.
- [meetily](https://github.com/Zackriya-Solutions/meetily) (MIT) is the local
  recorder this project builds on — see [NOTICE](NOTICE).

MIT License.
