# Architecture

One Node process (`dist/oma.mjs`, bundled from `src/`) plays four roles:

- **MCP server** (`oma mcp`, `src/mcp/server.ts`) — the tools agents call.
- **CLI** (`src/cli.ts`) — the same from a terminal.
- **Web UI** (`oma ui`, `src/ui/`) — a chat with the local agent beside the
  meetings, serving the page in `ui/` ([ui.md](ui.md)).
- **Worker** (`oma worker <call>`, `runWorker` in `src/pipeline.ts`) — started
  detached for each call, so a meeting keeps being followed and processed after
  the MCP server or the terminal that started it is gone. One per call (a lock
  file in the call folder; a dead holder is taken over). While the bot is in a
  meeting with `act` during/both it also runs the live loop (`liveStep`).

```
src/
  cli.ts              entry point (oma …)
  mcp/server.ts       MCP tools, prompt, setup check
  pipeline.ts         join / import / end / cancel, the worker, after-processing (plan, outputs, agent hook)
  live.ts             the agent in the meeting: live transcript, mentions, answers (model / connected agent / "noted")
  store.ts            calls on disk (~/.open-meeting-agent/calls/<id>/…), atomic JSON writes, lock
  sources/bot.ts      the bot container: start, status, leave, kill, outputs
  sources/meetily.ts  meetily's SQLite (read-only): meetings, timed transcript, notes, audio
  sources/screen.ts   local screen capture (ffmpeg avfoundation / x11grab / gdigrab)
  sources/huddle.ts   a meeting in the web UI: the page's uploads → the bot's files; live
                      transcript (whisper on the microphone, turn by turn); the recording after it
  asr/                transcription (whisper.cpp, OpenAI-compatible) + speaker names from the bot's timeline
  media/ffmpeg.ts     probe, 16 kHz audio, changed-screen detection (mpdecimate), frames
  plan/               prompt + rules, normalization, building (model or host) with a retry for empty plans
  llm/                the model: Anthropic Messages / OpenAI-compatible chat (fetch only),
                      or a local agent (Claude Code, any command)
  agents/             local agents: claude.ts (Claude Code's stream-json protocol, permission
                      requests included), command.ts (prompt on stdin, answer on stdout)
  ui/                 oma ui: server.ts (HTTP + events, token, localhost only), chats.ts (chats, turns)
  tasks.ts            ready tasks, next_task, update_task, the brief, autonomy rules
  github.ts           issues (GITHUB_TOKEN or gh)
  outputs/            delivering the plan: index (targets, deliverOutputs, live task creation),
                      tasks (Linear, Jira, ClickUp), crm (HubSpot), notion, webhook, http
  views.ts            text views for tools and CLI
bot/                  the meeting bot (its own package + Dockerfile); live.ts + liveText.ts read the
                      captions and chat and post in the chat
ui/                   the web UI's page: index.html, app.css, app.js (no build step)
skills/               Claude Code plugin skills
.claude-plugin/       plugin + marketplace manifests (the repo root is the plugin)
desktop/              meetily (submodule): the local recorder app
```

## A call's states

```
joining → in_call → processing → needs_plan → planned
   └──────────┴──────────┴─────────→ failed / cancelled
```

- `joining` / `in_call`: from the bot's `status.json`.
- `processing`: the worker transcribes (unless the import brought a
  transcript) and extracts frames.
- `needs_plan`: ready for `get_call_context` + `save_plan`, or `build_plan`.
  With a planning model configured the worker builds it right away.
- `planned`: tasks carry their own state: `todo → in_progress → done`, or
  `blocked` / `skipped`. A task is ready when every task it depends on is done
  or skipped.

`act` decides what happens around these states: with `during` / `both` the
worker answers in the meeting while the call is `in_call`; with `during`,
after-processing stops at the plan (nothing is delivered, no agent hook).
After the plan, with autonomy `issues` / `prs`, `deliverOutputs` sends each
output to its target ([outputs.md](outputs.md)).

## The bot ↔ host contract

The bot never talks to a server. Its volume (`calls/<id>/bot`, mounted at `/out`):

| File | Written by | |
|---|---|---|
| `status.json` | bot | `starting → joining → in_call → leaving → done` or `failed` (+ `step`, `error`, `participants`) |
| `control.json` | host | `{ "leave": true }` ends the call; `"discard": true` keeps nothing |
| `live.jsonl` | bot | appended while in the call: `{type:"caption", seg, speaker, text, final}` (a non-final turn is replaced by the next event with its `seg`), `{type:"chat", speaker, text}`, `{type:"sent", id, ok, error?}`, `{type:"live", captions, chat}` |
| `commands.jsonl` | host | appended: `{id, type:"chat", text}` — the bot posts each one in the chat, once, in order |
| `audio.m4a`, `recording.mp4` | bot | at the end (16 kHz mono audio; 1280×720 screen + audio) |
| `timeline.json` | bot | who spoke when: `{ transcriptEntries: [{ participant: { displayName }, startTime: "12.3s", endTime }] }` |
| `exit.json` | bot | why it left (`ended`, `manual`, `alone`, `max_duration`, `interrupted`…), seconds in the call, whether it saw anyone |

A container that disappears without `done` is processed with whatever it left.

A **huddle** (a meeting in the web UI) has no container: its page records and
uploads, and the UI server writes the same files — `status.json` (with `at`, a
heartbeat), caption turns from whisper on the microphone, the agent's answers
marked `sent` and pushed to the page — plus `huddle.json` and the recording
parts. The worker follows it like a bot call (a missing heartbeat instead of a
missing container), and `huddleRecording` joins the parts and writes the
timeline before the usual processing.
The bot starts with `LIVE_CHAT=1` when the call acts during the meeting (the
chat panel opens as it gets in; otherwise only when it has something to post).

## The agent in the meeting

The bot turns caption snapshots into turns (`bot/src/liveText.ts`: a turn
settles after a 2 s pause or when someone else speaks; long turns whose first
lines scroll out keep their text) and reads new chat lines. The worker's
`liveStep` reads `live.jsonl`, greets once, and for every settled line that
names the agent (speech or chat) waits for the person to finish, then answers:
with the planning model (reply, note, task created now), or leaves it to the
connected agent when it called `watch_meeting` in the last 90 s, or posts
"noted" and keeps the request as a note. `live-state.json` remembers what was
handled; `live-watch.json` when the connected agent last watched.

## The plan

Built from blocks on one timeline: the transcript lines, each frame (`[F3 ·
03:12] shared screen at this moment:` + the image) between the lines of the
moment it appeared, and the notes the person added after the call. The rules
(`planRules`) are the same for a model and for the connected agent; the JSON
is normalized the same way (unknown frames dropped, repository only one of the
call's, dependencies only backwards, at most 15 tasks / 4 frames each). A plan
with no task gets one more turn reminding that every request is a task; still
empty, the summary and questions go back to the person (`add_note` + plan again).
