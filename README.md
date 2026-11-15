# open-meeting-agent

An agent that **joins your meeting**, watches the screen you share, listens to
what you want done — and **keeps working after the call**: it turns the meeting
into a plan of small tasks (with acceptance criteria and screenshots from the
call) and your coding agent carries them out: issues, code, pull requests.

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
2. **After the call.** The recording is transcribed locally (whisper.cpp) or by
   any OpenAI-compatible API; each line gets the speaker's name; the moments the
   screen changed are kept as frames (F1, F2…).
3. **The plan.** The call is laid out on one timeline — transcript with each
   frame where it appeared — and becomes an execution plan: small tasks, each
   with what/where, 2–6 acceptance criteria, the frames that show it, the
   repository, `pr` or `issue`, priority and dependencies. **Your connected
   agent writes it** (`get_call_context` → `save_plan`), or a configured model
   does (`build_plan`: Anthropic or any OpenAI-compatible server, Ollama included).
4. **The work.** `distribute_plan` opens one GitHub issue per task.
   `next_task` hands your agent the next ready task (dependencies done) with
   its brief and screens; it implements it, opens the PR and `update_task`s it
   done, which unlocks the tasks that depend on it.

How far it goes without asking is the call's **autonomy**: `suggest` (stop at
the plan), `issues` (also open the issues), `prs` (also do the work and open
the pull requests). With `OMA_AGENT_COMMAND` set, your coding agent starts by
itself when the call is ready — see [docs/integrations.md](docs/integrations.md).

## Quick start (macOS)

Requirements: **Node ≥ 22.13**, **ffmpeg**, and — to join meetings — a running
container engine (Docker Desktop, OrbStack, Colima or Podman).

```bash
brew install ffmpeg
git clone <this repo> ~/Documents/GitHub/open-meeting-agent
cd ~/Documents/GitHub/open-meeting-agent
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

Other clients: [docs/integrations.md](docs/integrations.md).

### From a terminal

```bash
oma join https://meet.google.com/abc-defg-hij --repo acme/app --autonomy issues
oma end                     # the agent leaves; transcript + frames are processed
oma status
oma context                 # the call as your agent reads it
oma plan build              # with a configured planning model
oma issues
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

## MCP tools

| Tool | What it does |
|---|---|
| `join_meeting` | the bot joins a Meet/Teams link and records (screen + audio + speakers) |
| `end_meeting` / `cancel_meeting` | leave and process / leave and keep nothing |
| `import_meetily` | list meetily meetings, or import one |
| `import_recording` | import an audio/video file |
| `screen_capture` | record this screen (start/stop/status) |
| `list_calls` / `call_status` | the calls and where each one is |
| `get_call_context` | the call on one timeline (transcript + frames as images) + the plan rules |
| `get_frames` | frames by label |
| `save_plan` / `build_plan` / `get_plan` | the plan, written by your agent or by a model |
| `add_note` | the person's answer or correction after the call (goes into the plan) |
| `set_call` | link repositories, change autonomy, work folder, title |
| `distribute_plan` | one GitHub issue per task |
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
| `GITHUB_TOKEN` | gh CLI | for `distribute_plan` |
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
  plan.json         the plan and each task's state, issue and PR
  bot/              the bot's volume: status.json, control.json, audio.m4a, recording.mp4, timeline.json
  log.txt  worker.log  agent.log
```

Nothing leaves your machine except what you configure: the transcription API,
the planning model, GitHub, and whatever your coding agent sends.

## Status

Early (0.1). What has been exercised:

- the whole flow through the MCP server with a stand-in container engine,
  transcription, model and GitHub (`npm test`): join → end → transcript with
  speaker names → frames → plan (by the agent, or by a model with the retry for
  empty plans) → issues → tasks in dependency order; cancel; meetily import with
  a screen recording; recordings;
- the real bot image: it builds, boots (Xvfb, PulseAudio, Chromium), reports
  through its volume, and cancels;
- the Claude Code plugin: `claude plugin validate` passes, it installs from the
  marketplace and its MCP server connects.

Not yet run here: the bot in a live Google Meet / Teams call (its join and
speaker logic come from Queryable's production bot), whisper.cpp, and
`screen_capture` on macOS (it needs the Screen Recording permission).

## Development

```bash
npm install
npm run typecheck && npm test
npm run build                # → dist/oma.mjs (commit it: the plugin runs it)
cd bot && npm install && npm run typecheck
```

[docs/architecture.md](docs/architecture.md) explains the pieces.

## Credits

- The meeting bot (`bot/`) and the planning approach are ported from
  [Queryable](https://app.queryable.digital)'s agent calls; some comments in
  the bot drivers are still in Portuguese.
- [meetily](https://github.com/Zackriya-Solutions/meetily) (MIT) is the local
  recorder this project builds on — see [NOTICE](NOTICE).

MIT License.
