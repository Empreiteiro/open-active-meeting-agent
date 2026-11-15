# Working on open-meeting-agent

- Node ≥ 22.13, TypeScript, ESM. `src/` is bundled into `dist/oma.mjs` with
  esbuild; **commit `dist/oma.mjs`** after changing `src/` — the Claude Code
  plugin runs it straight from the repo.
- Checks: `npm run typecheck && npm test && npm run build`. The bot: `cd bot && npm run typecheck`.
- Tests (`test/`, node:test) use fake LLM/ASR servers and an ffmpeg-generated
  video; they never call real APIs or GitHub.
- `docs/architecture.md` maps the code; README's tables list the tools and
  settings — update them with the code.
- A change to the bot ↔ host files (status/control/outputs) touches both
  `bot/src/handback.ts` and `src/sources/bot.ts`, and needs the image rebuilt.
- Meet/Teams DOM selectors are fragile and live only in `bot/src/meet.ts` and
  `bot/src/teams.ts`.
- Model ids are configuration (`OMA_LLM_MODEL`), never hard-coded.
