# Acting in the meeting

By default the agent is quiet in the meeting and works once it is over. A call
can ask for more with **`act`**:

| `act` | In the meeting | After the meeting |
|---|---|---|
| `after` (default) | listens, records | plan + outputs (by the call's autonomy) |
| `during` | answers when someone addresses it | keeps the transcript and the plan; delivers nothing |
| `both` | answers when someone addresses it | plan + outputs (by the call's autonomy) |

Set it per call (`join_meeting { act }`, `oma join --act both`, or `set_call`
while the agent is already in the meeting), or by default with `OMA_ACT`.

## How it hears and how to call it

The bot turns on the meeting's own captions and reads them as turns (who said
what), and reads the chat. Someone addresses the agent by **saying its name**
("Meeting Agent, create a task to fix the login page") or **mentioning it in
the chat** ("@Meeting Agent …"). `OMA_LIVE_NAMES` adds other names people use
(`agente,assistente`). When it gets in, it says hello in the chat explaining
this (`OMA_LIVE_GREETING`: your own text with `{name}`, or `off`).

The agent understands the meeting only as well as the captions do: they must be
set to the language people speak (a caption setting in Meet and Teams). If
people speak Portuguese and the captions come out in English, it won't follow.
The recording after the call is transcribed separately, so the plan is not
affected.

## Who answers

1. **A planning model is configured**: the agent answers by itself, from the
   last minutes of conversation. `OMA_LLM_PROVIDER=claude-code` uses Claude
   Code on this machine (no API key; one click in the web UI); an API works too
   (`anthropic` / `openai` + `OMA_LLM_MODEL`).
2. **No model, and the connected agent is following** (`watch_meeting` in a
   loop — the Claude Code skill `/meeting-agent:live-meeting` does it): your
   agent sees each mention and answers with `send_meeting_message`, using its
   own tools for what is asked (a Linear/ClickUp/Notion MCP, the repository…).
3. **Neither**: the agent posts "noted — I'll take care of it after the
   meeting" and keeps the request as a note for the plan.

## What it does in the meeting

- **Replies in the chat** (short: one to three sentences).
- **Takes notes** for after the call: decisions and requests, with who asked.
  Notes go into the plan.
- **Creates a task right away** when someone asks for one, if the call's
  autonomy is `issues` or `prs` and its tasks go to Linear, Jira, ClickUp, a
  webhook, or GitHub with one repository. It posts the link in the chat; the
  plan after the call won't repeat it. With autonomy `suggest`, the request
  becomes a note and the task comes with the plan.
- **No code.** Pull requests only happen after the meeting.

Anyone in the meeting can address the agent. What they say is treated as what
was said, not as instructions that change its rules, and what it can do in the
meeting is limited to the list above.

## Limits

- Chat only for now: the agent writes, it doesn't speak.
- The chat selectors (`bot/src/meet.ts`, `bot/src/teams.ts`) are best-effort
  and haven't been run against a live Meet / Teams call yet. When they don't
  match, the live features stop and the recording goes on.
- Teams may give anonymous guests no chat (organizer policy): sign the bot in
  (`OMA_BOT_AUTH_TEAMS`).
- In `after` mode the chat panel stays closed: it would cover the recorded screen.

## Under the hood

The bot appends what it reads to `bot/live.jsonl` in the call folder (caption
turns, chat messages, the result of each post) and posts what the host appends
to `bot/commands.jsonl`. The worker (`oma worker <call>`) reads one, writes the
other, about once a second — see [architecture.md](architecture.md).
