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
   - **Planning model** (optional — without it you build the plan yourself): `OMA_LLM_PROVIDER` (`anthropic` or `openai` for any OpenAI-compatible server such as Ollama) + `OMA_LLM_MODEL` (+ key / `OMA_LLM_BASE_URL`).
3. Settings go in `~/.open-meeting-agent/config.json` (same names as the environment variables); the MCP server reads it on every start. After changing it, the user restarts the MCP server (`/mcp` in Claude Code).
4. `setup_status` again to confirm.
