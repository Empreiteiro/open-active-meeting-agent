---
name: meeting-agent-setup
description: Check and fix what the meeting agent needs on this machine — container engine and bot image, ffmpeg, transcription, GitHub, meetily. Use when joining a meeting or processing a call fails for a setup reason, or the user asks to set up the meeting agent.
---

# Set up the meeting agent

1. Call `setup_status` and read each line.
2. Fix what is missing, one item at a time, asking before installing anything:
   - **Container engine** (needed to join meetings): Docker Desktop, OrbStack, Colima or Podman, running.
   - **Bot image**: `build_bot` (a few minutes, ~3 GB, once). In a terminal: `node <plugin folder>/dist/oma.mjs bot build`.
   - **ffmpeg**: `brew install ffmpeg` (macOS), `apt install ffmpeg` (Linux), `winget install ffmpeg` (Windows).
   - **Transcription** (for meetings the bot recorded or files; meetily imports bring their own transcript), in `~/.open-meeting-agent/config.json`:
     - local: whisper.cpp (`brew install whisper-cpp`) with a model — `{"OMA_WHISPER_MODEL": "/path/to/ggml-large-v3-turbo.bin"}` (meetily's models work);
     - or an OpenAI-compatible API: `{"OMA_ASR_API_KEY": "…"}` (+ `OMA_ASR_BASE_URL` / `OMA_ASR_MODEL` for Groq or a local server).
   - **GitHub** (only for issues): `gh auth login`, or `GITHUB_TOKEN`.
   - **Where the outputs go** (optional; `docs/outputs.md` in the plugin folder has every setting): tasks `OMA_TASKS_TARGET` (`github`, `linear` + `LINEAR_API_KEY`, `jira` + `JIRA_*`, `clickup` + `CLICKUP_API_TOKEN` / `OMA_CLICKUP_LIST_ID`), CRM `OMA_CRM_TARGET` (`hubspot` + `HUBSPOT_TOKEN`), document `OMA_DOC_TARGET` (`file`, `notion` + `NOTION_TOKEN` / `OMA_NOTION_PARENT_PAGE_ID`); `webhook` + `OMA_WEBHOOK_URL`; `agent` needs nothing (you do it with your tools).
   - **Acting in the meeting** (optional): `OMA_ACT` (`after`, `during`, `both`), `OMA_LIVE_NAMES` (other names that call it).
   - **Planning model** (optional — without it you build the plan yourself): `OMA_LLM_PROVIDER` (`anthropic` or `openai` for any OpenAI-compatible server such as Ollama) + `OMA_LLM_MODEL` (+ key / `OMA_LLM_BASE_URL`).
3. Settings go in `~/.open-meeting-agent/config.json` (same names as the environment variables); the MCP server reads it on every start. After changing it, the user restarts the MCP server (`/mcp` in Claude Code).
4. `setup_status` again to confirm.
