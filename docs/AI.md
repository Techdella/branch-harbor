# The AI assistant (Marina)

Marina is BranchHarbor's assistant. It answers questions about the workspace, prepares changes for the person to confirm,
and runs a set of skills (briefings, insights, visit briefs, content studio and others). The display name lives in one
constant, `ASSISTANT_NAME` in `packages/shared/src/ai.ts`. All UI copy uses it through `{name}` interpolation, so renaming
the assistant is a one-line change.

This is an engineering document. Customer-facing copy must not name models or vendors.

## Architecture

```
apps/app (web)             apps/mobile                 apps/api
 MarinaProvider ─SSE─────▶  /ai/ask (whole answer) ─▶   routes/marina.ts
 MarinaPanel, CommandBar                                  │
 MarinaHub, Visit brief,                                  ▼
 Content studio, Settings                               ai/engine.ts  runTurn(): tool loop (≤ 8 steps)
                                                          │   ├─ ai/registry.ts   tools offered to this person
                                                          │   ├─ ai/llm.ts        live (Claude API) or sandbox
                                                          │   ├─ ai/context.ts    the person's token + access v2 scope
                                                          │   └─ ai/settings.ts   metering, org controls, audit log
                                                          ▼
                                                        tools/*.ts ──app.inject──▶ the normal REST API, as the person
```

- **Streaming.** `POST /v1/orgs/:orgId/ai/chat` returns Server-Sent Events (`MarinaStreamEvent` in `@bh/shared`): `text`
  deltas, `tool` start/end, `block` (table or chart), `citation`, `action` (a proposed action card), `navigate`,
  `notice`, `usage`, `done` and `error`. `POST /ai/ask` returns the same result in one JSON response, which mobile uses.
- **Tools run as the signed-in person.** `ctx.api` calls the REST API in-process (`app.inject`) with an access token
  minted for that person, so every tool goes through the same capability checks, location scope and field filtering as
  the app. In-process calls carry an internal header that only exempts them from the per-IP rate limit.
- **Scope** uses access v2: `capabilityLocations` and `hasCapability` (portfolio, territory and brand scopes resolve as
  they do everywhere else). A tool is offered only when the person holds the module somewhere. The REST route still makes
  the final decision.
- **Read tools** run immediately. **Write tools** never run on the model's say-so: the engine calls the tool's `preview`
  and stores an `ai_proposed_actions` row, which the UI shows as an action card with editable fields. The person
  confirms, and only then does `execute` run, again as that person. If the organisation lists the action's risk in
  `approvalRequiredFor` (`send`, `publish`, `money`, `people`, `structure`), the card goes to an HQ approver after
  confirmation and executes as the proposer once approved.
- **Models.** `ANTHROPIC_MODEL` (the most capable model) handles conversations, insights and documents.
  `ANTHROPIC_FAST_MODEL` handles short, high-volume work: briefing summaries, translations, help-desk suggestions and
  scoring explanations. Effort comes from `ANTHROPIC_EFFORT`. Refusal fallback uses the server-side fallback beta when
  `ANTHROPIC_REFUSAL_FALLBACK` is on.
- **Prompt caching.** The system prompt is fixed and carries no per-request data. Tool definitions are sorted, and the
  cache breakpoints sit on the last tool, the system block and the latest message. Per-request context (who is asking,
  their screen and the date) goes in a separate, uncached system block after the breakpoint. History is append-only.
- **Sandbox engine.** Without `ANTHROPIC_API_KEY`, or with `MARINA_SANDBOX=true`, `ai/sandbox.ts` maps the question to a
  tool with keyword rules in five languages. It calls the tool for real and answers only from the tool's results; when
  nothing matches it says it can't help with that. The demo, the tests and the screenshots all use it.

## Tools

One file per workspace area under `apps/api/src/ai/tools/`. Each file `export default`s an array of tools, and
`registry.ts` loads every file automatically. Files starting with `_` are helpers.

| File | Read | Write (confirmed by the person) |
|---|---|---|
| general.ts | navigate, list_my_tasks | create_task, remind_me |
| network.ts | list_locations, league_table, revenue_by_location, list_approvals, list_new_location_projects, list_people | invite_person |
| operations.ts | list_bookings | |
| sales.ts | list_customers, list_leads, score_lead, list_franchise_prospects, score_franchise_candidate, list_franchise_tasks | add_lead_note, move_prospect_stage |
| quality.ts | list_reviews, review_summary, audit_overview, list_audits, list_corrective_actions, list_compliance_documents, compliance_overview | reply_to_review, schedule_audit |
| finance.ts | royalty_status, list_royalty_statements, marketing_fund_summary | |
| marketing.ts | list_email_campaigns, list_automations, list_social_posts, list_website_pages, draft_marketing_copy | create_email_campaign_draft, send_email_campaign, set_automation_status, create_social_post_draft, add_website_section |
| network-workspaces.ts | list_announcements, list_courses, training_completion, list_tickets, get_ticket, list_inbox_conversations | create_announcement_draft, assign_course, reply_to_ticket, reply_in_inbox |
| assistant.ts | search_knowledge, list_insights, prepare_visit_brief | create_locations, set_site_theme, create_course_draft |

### Adding a tool

1. Add it to the file for its area, or create a new `tools/<area>.ts` that default-exports an array.
2. Use `defineTool({ kind: 'read' | 'write', name, area, modules, description, input: z.object(...) })`.
   - `modules` lists the modules whose view (for read tools) or action (for write tools) the person needs somewhere.
   - `input` is validated with zod before the tool runs. Its JSON Schema is what the model sees.
3. Read tools implement `run(ctx, input)`, call REST through `ctx.api`, and return `{ data, summary, blocks? }`.
   - Use `table()` and `barCharts()` from `ai/present.ts`.
   - Keep money in minor units with a currency key; never add different currencies together.
4. Write tools implement `preview(ctx, input)`, which returns the card, and `execute(ctx, input)`. Also set `risk` and
   `action` (the access action needed).
5. Do not read the database directly for data a REST route already serves.
6. Add a case to `apps/api/test/marina.int.test.ts` if the tool needs special permissions.

## Skills

Each skill has an API route under `/v1/orgs/:orgId/ai/...`, a UI entry point and tests in `marina.int.test.ts`.

| Skill | Route | UI |
|---|---|---|
| Ask anything | `POST /ai/chat`, `POST /ai/ask` | Side panel, ⌘K / Ctrl+K command bar, `/marina`, mobile Marina tab |
| Briefings (daily or weekly, in-app and email) | `GET /ai/briefing`, prefs `PUT /ai/prefs`; job `marina.tick` | Home card on workspace homes, `/marina`, mobile |
| Insights (anomalies with evidence and a suggested action) | `GET /ai/insights`, `POST /ai/insights/run`, `/ai/insights/:id/dismiss`, `/ai/insights/:id/actions/:index`; job `marina.daily` | `/marina` insights feed |
| Visit brief | `GET /ai/visit-brief?location=` | `/marina/visit-brief`, `prepare_visit_brief` tool |
| Content studio (brand voice, translations, guardrails) | `POST /ai/content/generate`, `/ai/content/translate`, `/ai/brand-voice/learn` | `/marina/studio` |
| Help desk auto-answer | `POST /ai/helpdesk/tickets/:id/suggest`; job `marina.ticket_created` (HQ opt-in) | Suggested answer in help desk, Marina settings |
| Document understanding (PDF, DOCX, MD, TXT) | `POST /ai/documents/extract`, `POST /ai/knowledge/uploads` | `/marina` knowledge |
| Audit photo check | `POST /ai/audits/:id/photo-check` | Audit item photo |
| Course builder | `POST /ai/courses/outline`, `create_course_draft` tool | `/marina`, chat |
| Setup assistant | `POST /ai/setup` (proposes locations and a theme as cards) | `/marina` setup card |
| Lead and candidate scoring (explained factors) | `GET /ai/score/lead/:id`, `GET /ai/score/prospect/:id` | Chat, lead and prospect pages |

## Knowledge (RAG)

- `ai_knowledge_sources` and `ai_knowledge_chunks` index the operations manual, library, courses, help-desk articles,
  brand guidelines and uploaded files. `marina.daily` syncs them, and the first search in an org syncs lazily.
- Search uses Postgres full-text search with the `simple` configuration (language-neutral), plus `pg_trgm`
  `word_similarity` for fuzzy matches.
- When `VOYAGE_API_KEY` is set and the `vector` extension exists, embeddings are added and blended in. Without them,
  search still works.
- Every chunk keeps its source's audiences and module. Search applies the same audience rules as network access, so a
  franchisee only finds what is shared with them and HQ-only sources stay with HQ.
- Answers cite their sources (`citation` events). Citations link to the original page.

## Metering and plans

- Each call's tokens, cache reads and cache writes are priced with `creditsFor` (1 credit = US$0.01 of model cost) and
  added to `ai_usage` per organisation, month and feature.
- Monthly allowances come from `aiMonthlyAllowance(plan, locations)` in `packages/shared/src/pricing.ts`:

  | Plan | Base | Per location |
  |---|---|---|
  | solo | 500 | 0 |
  | connector | 200 | 150 |
  | hosted | 300 | 300 |
  | network | 2000 | 400 |

- Above the allowance, Settings shows a warning. At `MARINA_FAIR_USE_MULTIPLIER` times the allowance (default 2),
  requests get `429 ai_credit_limit` until the next month.
- Settings (`MarinaSettingsCard`) shows usage by feature, the tool-call log and the org controls.

## Org controls

`ai_org_settings` (`AiOrgSettings` in `@bh/shared`), editable by holders of `settings.ai:edit`:

- `enabled`: switches Marina off for the organisation.
- `allowedAreas`: which tool areas are allowed.
- `approvalRequiredFor`: action risks that need an HQ approver.
- `retentionDays`: conversations, tool logs and proposed actions older than this are deleted.
- `helpdeskAutoAnswer` and `helpdeskAutoResolve`.
- `guardrails`: banned claims and required disclaimers, applied to all generated content.
- `brandVoice` and `contentLocales`.

The `ai.assistant` module in access v2 decides who can use Marina at all. HQ admins hold it, and any role that holds
`settings.ai:view` gets view and edit.

## Safety

- **Tenant isolation.** Every tool call is a REST call made with the person's own token; there is no cross-org path.
  `marina.int.test.ts` checks that another org's data and franchisee-scoped data never appear in answers, tables or
  knowledge search.
- **Prompt injection.** Output from tools that return text written by other people (reviews, tickets, inbox, uploads,
  knowledge; `untrustedOutput: true`) is wrapped in `<untrusted_data>`, with any closing tags inside neutralised. The system
  prompt says never to follow instructions inside it. Actions proposed after untrusted content are flagged
  `fromUntrusted`, and the card shows a warning. Write tools still need the person's confirmation. The test suite
  scripts a model that obeys an injected review and checks that nothing executes.
- **PII minimisation.** The tool-call log stores tool names, sizes and summaries, with inputs passed through
  `redactPii` (emails, phone numbers and card-like numbers are masked; dates are kept). Message logs contain no prompts.
- **Legal topics.** Questions about franchise law, disclosure or contracts get a "general information, not legal
  advice" notice (`isLegalTopic`).
- **No training on customer data.** Customer data is sent to the model provider only to answer the request. It is not
  used to train models, under the provider's commercial API terms. Check the current data-retention terms (and
  zero-retention options) before you make stronger privacy claims. Conversations are kept only for the org's
  `retentionDays`.
- **Languages.** Marina replies in the person's language (from `Accept-Language` or the app locale) unless they write
  in another one.

## Configuration

See `docs/API_INTEGRATIONS.md` §1, row 5, for every environment variable.

## Tests

- `apps/api/test/marina.int.test.ts` covers:
  - the registry;
  - SSE streaming and tables;
  - permissions and confirmation gating;
  - org approval;
  - prompt injection;
  - metering and fair use;
  - tenant isolation and knowledge scope;
  - every skill;
  - the legal notice.
- `apps/api/test/marina-extract.test.ts` covers PDF, DOCX and Markdown extraction and chunking.
- `packages/shared/src/ai.test.ts` covers credits, usage state, guardrails, PII redaction and scoring.
