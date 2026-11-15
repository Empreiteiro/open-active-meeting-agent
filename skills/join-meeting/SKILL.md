---
name: join-meeting
description: Send the meeting agent into a Google Meet or Microsoft Teams call to watch the shared screen and listen to what the person wants done. Use when the user shares a meet.google.com / teams link and asks you to join, attend, sit in, or "come to the call".
argument-hint: <meeting link> [what the call is about]
---

# Join a meeting as the agent

The user wants you in a call: $ARGUMENTS

1. Call the `join_meeting` tool of the **meeting-agent** MCP server with:
   - `url`: the meeting link.
   - `title`: a short title from what the user said (optional).
   - `repos`: the GitHub repository of the current project when there is one (`owner/repo`, from `git remote get-url origin`), so the tasks can become issues and pull requests there.
   - `autonomy`: only if the user said how far to go without asking — `suggest` (stop at the plan), `issues` (also deliver the outputs), `prs` (also do the code and open the pull requests).
   - `act`: only if the user said when the agent should act — `after` (quiet in the call, the default), `during` (answers in the meeting when someone addresses it), `both`.
   - `outputs`: only if the user said where things should go — `tasks` (`github`, `linear`, `jira`, `clickup`, `webhook`, `agent` = you with your own tools), `crm` (`hubspot`, `webhook`, `agent`), `doc` (`file`, `notion`, `webhook`, `agent`).
2. If it fails because the bot image is missing or no container engine is running, run the `meeting-agent-setup` skill.
3. Tell the user, in one or two lines: the agent is joining as "<agent name>", admit it from the lobby if asked, share the screen and explain; say "end the call" (or use `/meeting-agent:plan-meeting`) when done.

While the call runs, `call_status` shows whether the agent got in (`in_call`) and how many people it sees. Don't poll in a loop; check when the user asks.

With `act` `during` or `both` and no planning model configured (the `join_meeting` answer says so), you are the agent's brain in the meeting: continue with the `live-meeting` skill.

When the user says the call is over, call `end_meeting` and continue with the `plan-meeting` skill.
