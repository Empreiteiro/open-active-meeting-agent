---
name: live-meeting
description: Be the meeting agent's brain while it is in a Google Meet / Teams call — follow what is said, answer in the meeting chat when someone addresses the agent, and do what they ask with your tools. Use when the agent was sent with act "during" or "both" and no planning model is configured, or when the user asks you to follow, help or answer in the meeting.
argument-hint: [call id]
---

# Answer in the meeting

Call: $ARGUMENTS (empty = the latest call).

1. `call_status`. The agent must be `joining` or `in_call` with `acts: during` or `both` (if it says `after`, ask the user, then `set_call { act: "both" }`).
2. Loop while the call is `joining` / `in_call`:
   - `watch_meeting { since, wait_seconds: 25 }` — new caption turns and chat lines; lines starting with `→ MENTION` are someone addressing the agent. Keep `since` = the returned `next`.
   - For each mention: read the lines around it, then answer with `send_meeting_message` — one to three short sentences, in the language people are speaking. Answer from what was said; say what you will do; ask when something is missing.
   - When they ask for something you can do now with your tools (create a task in their platform, look something up in the repository, draft a message), do it and post the link or result in the chat. Never change code or open pull requests during the meeting: say it will be done after, and `add_note` the request.
   - Decisions and requests worth keeping for after the call: `add_note` (they go into the plan).
   - If `watch_meeting` says the planning model answers by itself, don't answer too — just follow.
3. When the call is over (`watch_meeting` says so), stop the loop and continue with the `plan-meeting` skill.

Keep each turn light: don't summarize the whole meeting back to the user while it runs; tell them only what you did in it.
