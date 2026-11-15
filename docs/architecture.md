# Architecture

One Node process (`dist/oma.mjs`, bundled from `src/`) plays three roles:

- **MCP server** (`oma mcp`, `src/mcp/server.ts`) — the tools agents call.
- **CLI** (`src/cli.ts`) — the same from a terminal.
- **Worker** (`oma worker <call>`, `runWorker` in `src/pipeline.ts`) — started
  detached for each call, so a meeting keeps being followed and processed after
  the MCP server or the terminal that started it is gone. One per call (a lock
  file in the call folder; a dead holder is taken over).

```
src/
  cli.ts              entry point (oma …)
  mcp/server.ts       MCP tools, prompt, setup check
  pipeline.ts         join / import / end / cancel, the worker, after-processing (plan, issues, agent hook)
  store.ts            calls on disk (~/.open-meeting-agent/calls/<id>/…), atomic JSON writes, lock
  sources/bot.ts      the bot container: start, status, leave, kill, outputs
  sources/meetily.ts  meetily's SQLite (read-only): meetings, timed transcript, notes, audio
  sources/screen.ts   local screen capture (ffmpeg avfoundation / x11grab / gdigrab)
  asr/                transcription (whisper.cpp, OpenAI-compatible) + speaker names from the bot's timeline
  media/ffmpeg.ts     probe, 16 kHz audio, changed-screen detection (mpdecimate), frames
  plan/               prompt + rules, normalization, building (model or host) with a retry for empty plans
  llm/                Anthropic Messages / OpenAI-compatible chat (fetch only)
  tasks.ts            ready tasks, next_task, update_task, the brief, autonomy rules
  github.ts           issues (GITHUB_TOKEN or gh)
  views.ts            text views for tools and CLI
bot/                  the meeting bot (its own package + Dockerfile)
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

## The bot ↔ host contract

The bot never talks to a server. Its volume (`calls/<id>/bot`, mounted at `/out`):

| File | Written by | |
|---|---|---|
| `status.json` | bot | `starting → joining → in_call → leaving → done` or `failed` (+ `step`, `error`, `participants`) |
| `control.json` | host | `{ "leave": true }` ends the call; `"discard": true` keeps nothing |
| `audio.m4a`, `recording.mp4` | bot | at the end (16 kHz mono audio; 1280×720 screen + audio) |
| `timeline.json` | bot | who spoke when: `{ transcriptEntries: [{ participant: { displayName }, startTime: "12.3s", endTime }] }` |
| `exit.json` | bot | why it left (`ended`, `manual`, `alone`, `max_duration`, `interrupted`…), seconds in the call, whether it saw anyone |

A container that disappears without `done` is processed with whatever it left.

## The plan

Built from blocks on one timeline: the transcript lines, each frame (`[F3 ·
03:12] shared screen at this moment:` + the image) between the lines of the
moment it appeared, and the notes the person added after the call. The rules
(`planRules`) are the same for a model and for the connected agent; the JSON
is normalized the same way (unknown frames dropped, repository only one of the
call's, dependencies only backwards, at most 15 tasks / 4 frames each). A plan
with no task gets one more turn reminding that every request is a task; still
empty, the summary and questions go back to the person (`add_note` + plan again).
