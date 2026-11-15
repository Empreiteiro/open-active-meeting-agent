---
name: work-on-meeting
description: Carry out the tasks planned from a meeting — implement each one in the repository, check it against its acceptance criteria and open the pull request — in dependency order. Use when the user asks to do the work from the call, work the plan, or continue the meeting's tasks.
argument-hint: [call id] [task key]
---

# Work the meeting's plan

Call: $ARGUMENTS (empty = the latest call; a task key like `t2` = only that task).

Repeat until `next_task` says nothing is left (or only the task the user named):

1. `next_task` — the brief of the task in progress or the next ready one: what to change and where, the acceptance criteria, the screens from the call (look at them: they show what the person meant), the deliverable and the rule for this call's autonomy.
2. Work in the repository of the task (`repo`; the call's work folder when it is the current project). Read the code before changing it; keep the change to what the task asks.
3. Check every acceptance criterion; run the project's own checks (tests, typecheck, lint) on what you changed.
4. Deliver by the autonomy rule in the brief:
   - `prs`: commit on a new branch, push, open the pull request (`gh pr create`), its body closing the task's issue (`Closes #N` when there is an issue) and saying how each criterion is met and how to test.
   - otherwise: show the user the change and open the pull request only after they confirm.
5. `update_task` with `state: "done"` and `pr_url` — or `state: "blocked"` with a `note` saying exactly what is missing (a decision, access, a repository). A blocked task doesn't stop the others: take the next one.

A task with `deliverable: issue` asks for a decision or an investigation, not code: write the answer (in the issue, or to the user) and mark it done with a note.

At the end, tell the user what was delivered: each task with its PR, and what is blocked and why.
