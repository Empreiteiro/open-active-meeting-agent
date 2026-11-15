# meetily

[meetily](https://github.com/Zackriya-Solutions/meetily) is an open-source (MIT)
desktop app — Tauri (Rust) + Next.js — that records meetings on your machine
(microphone + system audio), transcribes them locally (Whisper / Parakeet) and
writes summaries. It doesn't join calls and doesn't record the screen.

open-meeting-agent uses it as the **local recorder**: you keep using meetily
for the meetings you attend yourself, and the agent picks them up afterwards.

## What is read

meetily's SQLite (`~/Library/Application Support/com.meetily.ai/meeting_minutes.sqlite`
on macOS), opened read-only with Node's built-in `node:sqlite`:

| meetily | becomes |
|---|---|
| `meetings` (id, title, created_at, folder_path) | the call (title, start time) |
| `transcripts` (transcript, audio_start_time, audio_end_time, speaker = mic/system) | timed segments; mic → "Me", system → "Others" |
| `meeting_notes.notes_markdown` | a note on the call (goes into the plan) |
| `<folder_path>/audio.mp4` | the call's audio |

Older databases without `audio_start_time` fall back to the rows' timestamps.

## The screen

meetily records sound only. `oma screen start` / `stop` (or the
`screen_capture` tool) records the screen at 1 frame/s with ffmpeg; importing a
meetily meeting picks the screen recording that overlaps it in time and places
its frames on the transcript's timeline. On macOS, give the terminal (or the
app running the MCP server) the Screen Recording permission.

## The submodule

`desktop/` points at meetily's repository:

```bash
git submodule update --init desktop
```

It is not built by this project; follow meetily's own build instructions
(`desktop/docs/BUILDING.md`). Natural next steps in the app itself — "Send to
agent" on a meeting (runs `oma meetily <id>`), and recording the screen next to
the audio — would live in a fork of that submodule.
