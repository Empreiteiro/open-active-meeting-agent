---
name: plan-meeting
description: Turn a finished meeting (joined by the meeting agent, recorded with meetily, or a recording file) into an execution plan of small tasks with acceptance criteria and screenshots from the call. Use after a call ends, or when the user asks to plan, summarize into tasks, or "what did we agree in the call".
argument-hint: [call id]
---

# Plan a meeting

Call: $ARGUMENTS (empty = the latest call).

1. `call_status`. If the agent is still in the meeting and the user says it's over, `end_meeting`. While it is `processing` (transcribing, reading the screen), wait a little and check again — a few minutes for a long call.
2. When it is `needs_plan`:
   - Read the call with `get_call_context` — the transcript with the shared screens where they appeared, the notes, and the rules and JSON format of the plan. Fetch any other screen you need with `get_frames`.
   - Look at the project (the repository in the working folder) enough to place each task: which screen, component, route or file.
   - Write the plan following the rules exactly and save it with `save_plan`. Every change the person asked for is a task, even a one-sentence request; open points go to `questions` and the task follows the most reasonable reading, saying what it assumed.
   - (If a planning model is configured, `build_plan` does the same without you.)
3. Show the user the plan: title, tasks (key, title, deliverable, dependencies) and the open questions. If they answer a question or correct something, `add_note` with their words and plan again.
4. Then, by the call's autonomy (shown by `call_status`):
   - `suggest`: stop. The user decides what goes next ("open the issues", "do t1", "do everything").
   - `issues`: `distribute_plan` (asks for a repository when the call has none).
   - `prs`: `distribute_plan`, then run the `work-on-meeting` skill.

A plan with no repository still works: `set_call` with `repos` links one later.
