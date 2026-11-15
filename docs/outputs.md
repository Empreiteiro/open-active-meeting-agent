# Outputs: tasks, CRM, document

After the call the plan is delivered where the team works. Each call has three
outputs, each with a target (or none):

| Output | Targets | What is delivered |
|---|---|---|
| `tasks` | `github` (default) · `linear` · `jira` · `clickup` · `webhook` · `agent` | one item per task: description, acceptance criteria as a checklist, dependencies linked, priority |
| `crm` | `hubspot` · `webhook` · `agent` | the company and contacts (found or created), a deal when one was discussed, and a note with the summary and next steps on all of them |
| `doc` | `file` · `notion` · `webhook` · `agent` | the meeting document (minutes by default, or your template) |

Set them per call (`join_meeting { outputs: { tasks: "clickup", crm: "hubspot", doc: "notion" } }`,
`oma join --tasks clickup --crm hubspot --doc notion`, `set_call`), or by
default with `OMA_TASKS_TARGET`, `OMA_CRM_TARGET`, `OMA_DOC_TARGET`.

When the call has a CRM or document output, the plan carries them too: the
model (or your agent, through `get_call_context`) writes a `crm` part (only
facts that were said: no guessed emails, amounts or dates) and a `doc` part.

## When they are delivered

- By itself after the call when the autonomy is `issues` or `prs` (and `act`
  is `after` or `both`).
- On request: `distribute_plan` (all, or `only: "crm"`…), `oma deliver [call] [--only kind]`.

Delivery is idempotent: a task with a link, or a CRM update / document already
delivered, is not sent again.

## Setting up each target

| Target | Settings |
|---|---|
| `github` | `GITHUB_TOKEN` or the `gh` CLI; tasks need a repository (`repos`) |
| `linear` | `LINEAR_API_KEY`; `OMA_LINEAR_TEAM` (key like `ENG`, name or id — optional with one team) |
| `jira` | `JIRA_BASE_URL` (`https://you.atlassian.net`), `JIRA_EMAIL`, `JIRA_API_TOKEN`, `OMA_JIRA_PROJECT`; `OMA_JIRA_ISSUE_TYPE` (`Task`) |
| `clickup` | `CLICKUP_API_TOKEN`, `OMA_CLICKUP_LIST_ID` |
| `hubspot` | `HUBSPOT_TOKEN` (a private app with CRM objects read/write); new deals go to `OMA_HUBSPOT_PIPELINE` (`default`) / `OMA_HUBSPOT_DEAL_STAGE` (`appointmentscheduled`) |
| `notion` | `NOTION_TOKEN` (an integration) and `OMA_NOTION_PARENT_PAGE_ID` (a page shared with it) or `OMA_NOTION_DATABASE_ID` (+ `OMA_NOTION_TITLE_PROPERTY`, `Name`) |
| `file` | `OMA_DOC_DIR` (`<dir>/<date>-<title>.md`); unset: `document.md` in the call folder |
| `webhook` | `OMA_WEBHOOK_URL`; `OMA_WEBHOOK_SECRET` signs each body |
| `agent` | nothing: your connected agent does it |

`setup_status` (or `oma doctor`) shows what is missing for the defaults.

**The document's shape**: `OMA_DOC_TEMPLATE` points to a markdown file whose
structure the document follows (your minutes template, a brief, a proposal).

## `agent`: your agent puts it in place

With the target `agent`, `distribute_plan` hands the content to the connected
agent with what to do, and it uses its own tools — the MCP connectors it has
for HubSpot, Salesforce, Pipedrive, Notion, Google Docs, Confluence, Asana,
Trello, Monday… — then records the link (`update_task { issue_url }` for each
task, `record_output { kind, url }` for the CRM and the document). This is the
way to reach a platform without a built-in target.

## `webhook`: anything else

One URL for all outputs (Zapier, Make, n8n, a script). A `POST` with JSON:

```json
{ "event": "tasks", "call": { "id": "…", "title": "…", "meeting_url": "…" }, "plan": { "title": "…", "summary": "…" },
  "tasks": [{ "key": "t1", "title": "…", "priority": "high", "depends_on": [], "acceptance": ["…"], "markdown": "…" }],
  "sent_at": "…" }
```

`event` is `tasks`, `crm` (with `crm`), `doc` (with `doc: {title, markdown}`)
or `task` (one task created during the meeting). With `OMA_WEBHOOK_SECRET`,
`x-oma-signature: sha256=<hex HMAC-SHA256 of the body>`. The answer may report
links: `{"url": "…"}`, or for tasks `{"items": [{"key": "t1", "url": "…"}]}`.
