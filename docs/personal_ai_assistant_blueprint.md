Personal AI Assistant — Engineering Blueprint &
Chronological Build Plan

Cost-first, security-first, Telegram control hub with multi-mailbox intelligence

1. Executive Summary

Build a personal AI assistant as a modular event-driven system. Telegram is the first control/notification interface;
email is the first external data domain. The first production-worthy milestone is simple: connect multiple Gmail
accounts, detect important messages including spam where the provider API permits it, notify you in Telegram,
summarize the message, draft a reply when useful, and require your explicit approval before sending.

The architecture must separate the assistant core from channels and providers. Gmail, Zoho, Outlook, Calendar,
Drive, Linear, WhatsApp and future iMessage support are connectors. Gemini/Anthropic/OpenAI are interchangeable
AI providers. This prevents the first MVP from becoming a dead-end.

2. Product North Star

The assistant becomes a personal operating layer for communications and commitments: it detects important
information, understands project context, proposes actions, asks for approval for consequential actions, and keeps
your schedule and task system aligned.

Examples: detect a buried interview email; explain why it matters; locate the relevant document in Drive; draft a reply;
ask for approval; send it; create a calendar item; and record the resulting task/follow-up.

3. MVP Scope — Do This First

Telegram chat + voice notes; Gemini-backed reasoning; multiple Gmail accounts; important-email classification;
notifications; full message + TL;DR; draft reply; approval/send flow; basic audit log; simple scheduled morning digest.

Explicitly out of MVP: Zoho, Outlook, Calendar, Drive, Linear, WhatsApp, iMessage, autonomous sending, meeting
bots, phone calls, vector database, multi-agent swarm.

4. Accounts & Credentials Checklist

REQUIRED NOW: GitHub account/repository; Telegram account + BotFather bot token; Google account(s) to be
connected; one Google Cloud project; Gemini API key; Supabase account/project; Railway account for deployment.

GMAIL: For each Gmail mailbox, OAuth authorization is required. Use one Google Cloud project and authorize each
mailbox separately. Store an account record so account identity is never mixed: provider, mailbox email, OAuth
credential reference, labels/folders, display name, priority rules.

OPTIONAL NOW: Linear account if you want a task board later. Do not connect it until email + calendar flows are
stable.

LATER: Microsoft Entra/Azure app registration for Outlook/Microsoft Graph; Zoho API Console OAuth client for each
Zoho account authorization; Google Drive/Calendar scopes; WhatsApp Business/Cloud API; Apple/Mac companion if
iMessage/SMS access becomes a requirement.

5. Credentials / Environment Variables

Use a secret manager or Railway variables in deployment. Never commit credentials. Suggested variables:
DATABASE_URL, TELEGRAM_BOT_TOKEN, GEMINI_API_KEY, APP_BASE_URL, ENCRYPTION_KEY,
SESSION_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI.

Do not hard-code per-mailbox OAuth refresh tokens into .env. Store encrypted credential records in the database,
keyed by connected account. The .env should contain only application-level secrets and OAuth client configuration.

6. Recommended Stack

TypeScript + Node.js; Fastify or equivalent HTTP server; PostgreSQL via Supabase; Prisma; Zod; Telegram Bot API;
Gemini initially; Google Gmail API + Cloud Pub/Sub for push; Railway for hosting; GitHub for source control.

Avoid adding Redis, a vector database, LangChain/LangGraph, Composio, or a second AI provider until a real
requirement appears. You can add abstractions without adding infrastructure.

7. Architecture

Telegram ﬁ Channel Adapter ﬁ Assistant Orchestrator ﬁ Intent/Tool Planner ﬁ Provider Connectors ﬁ
PostgreSQL. Scheduled jobs and provider webhooks enter through the same event pipeline. AI is used for
classification, extraction, summarization and drafting; deterministic code performs authorization, validation and tool
execution.

Important separation: the LLM never directly calls Gmail or sends email. It proposes a typed tool call. The application
validates permissions, account identity, target, attachments and approval state, then executes the connector.

8. Core Data Model

connected_accounts(id, provider, account_email, display_name, status, encrypted_credentials_ref, metadata);
messages(id, account_id, provider_message_id, thread_id, folder, sender, recipients, subject, body_ref, received_at,
importance, classification, processed_at); drafts(id, message_id, body, status); approvals(id, action, target,
payload_hash, status, expires_at); notifications(id, channel, destination, message_id, sent_at); tasks(id, title,
project_id, priority, status, due_at, source_message_id); projects(id, name, context); events/audit_logs for every tool
execution.

9. Phase 0 — Foundation & Accounts

Create GitHub repo, Railway project, Supabase project, Telegram bot, Google Cloud project, Gemini API key.
Configure local development, .env.example, secret handling, database migrations, logging and health endpoint.

Exit criteria: app starts locally; database connects; Telegram webhook works; Gemini can answer a test prompt; no
secret is committed.

10. Phase 1 — Telegram + Single Gmail

Build Telegram inbound/outbound adapter. Implement Google OAuth for one Gmail mailbox. Implement commands:
/connect, /status, /digest, /help. Create a mailbox record and persist messages/events.

First workflow: new email ﬁ fetch message ﬁ deterministic metadata extraction ﬁ AI importance classification ﬁ if
important, Telegram notification ﬁ user can request summary/draft.

For the first test, do not send mail. Draft only.

11. Phase 2 — Important Email Detection

Define importance classes: CRITICAL, HIGH, NORMAL, LOW, IGNORE. Score using sender relationship, subject
signals, deadlines, job/interview language, explicit requests, existing thread history, and project context.

Important: do not only monitor Inbox. Your sync strategy must account for Spam and other relevant folders/labels so
buried interview messages are not silently missed. Provider-specific folder semantics must be represented in the
connector.

Notification format: source account; sender; subject; why it matters; deadline; full content on demand; TL;DR;
suggested action.

12. Phase 3 — Approval & Draft Reply

User flow: Telegram notification ﬁ 'draft a reply' ﬁ assistant retrieves thread + relevant project/person context +
approved files ﬁ generates draft ﬁ displays draft ﬁ user says 'send' ﬁ application validates approval ﬁ connector
sends.

Default policy: no autonomous external sending. Require explicit approval for email send, delete, unsubscribe,
calendar creation that affects others, and any external communication.

13. Phase 4 — Multiple Gmail Accounts

Repeat OAuth authorization for all three Gmail accounts. Treat every mailbox as an independent connected account.
Every message, draft and action carries account_id.

Allow rules such as: 'recruiting Gmail is highest priority for interview mail'; 'personal Gmail is low priority for
promotions'. Never let the model infer the sending account when a user has multiple accounts; require deterministic
account selection.

14. Phase 5 — Email Actions

Add reply, forward, archive, label, mark read/unread and unsubscribe only after approval. For unsubscribe, prefer
provider-supported unsubscribe mechanisms when available; otherwise draft the action or present a safe
link/instruction. Never click arbitrary unsubscribe URLs without validation.

15. Phase 6 — Voice Notes

Telegram voice ﬁ audio download ﬁ transcription provider abstraction ﬁ normalized text ﬁ normal assistant
pipeline. Gemini can be the first transcription option if its current model/API access fits your free-tier limits. Voice is an
input modality, not a separate agent.

16. Phase 7 — Zoho + Outlook

Add provider interfaces: EmailProvider.listMessages, getThread, draftReply, sendReply, search, archive, label,
unsubscribe. Implement Zoho first, then Microsoft Graph/Outlook. Each provider has its own OAuth tokens and
account record.

For Outlook, Microsoft Graph supports change subscriptions for messages and requires Mail.Read for message
notifications. Use least-privilege delegated permissions for your own mailboxes. (Microsoft Graph documentation)

Zoho Mail uses OAuth 2.0 with client ID/secret, authorization code, access token and refresh token. (Zoho Mail API
documentation)

17. Phase 8 — Google Calendar

Connect Calendar after email is reliable. Add read, create, update and delete as separate capabilities. Start with read
+ create. Build 'what is my day?', 'add this to my calendar', and pre-meeting briefing.

18. Phase 9 — Google Drive

Connect Drive as a context/document source. Add search, retrieve, and optionally create/upload later. Start
read-only. The agent should search by project/person/request before drafting replies that require attachments.

19. Phase 10 — Morning Brief & Proactive Assistant

Daily job gathers calendar, important unread mail, deadlines, pending drafts, tasks, blockers and follow-ups. Gemini
turns structured data into a concise brief. Telegram delivers it. Add pre-meeting alerts and deadline alerts.

20. Phase 11 — Memory & Project Context

Add structured project/person/task memory first. Add embeddings only when retrieval volume actually demands it.
Project context can include documents, notes, people, blockers, objectives and historical decisions.

Introduce a state machine: PLANNED ﬁ IN_PROGRESS ﬁ BLOCKED ﬁ WAITING ﬁ RESUMED ﬁ
COMPLETED. The assistant should remember blockers and follow-ups rather than treating each chat as isolated.

21. Phase 12 — Linear / Notion

Only after email + calendar + memory are stable. Start with Linear. Expose
read/create/update/status/priority/due-date/comment as typed tools. End-of-day flow: user reports
achievements/blockers ﬁ assistant proposes task-board changes ﬁ user approves ﬁ changes are applied.

22. Phase 13 — WhatsApp / Telegram User-Facing Expansion

Telegram remains the control hub in the first architecture. Later, add WhatsApp as a separate channel/provider where
the official API and account model support your use case. Do not assume an official WhatsApp Business API
provides unrestricted access to a personal WhatsApp history.

If you later need Telegram access to your personal Telegram account rather than a bot inbox, treat that as a separate
client/API integration and security boundary.

23. Phase 14 — iMessage / SMS

Do not make iMessage/SMS a cloud MVP dependency. If required, build a local Mac companion that exposes
narrow, authenticated capabilities to the cloud agent. Avoid giving the cloud service unrestricted access to the Mac or
Messages database.

24. Security Model

Use least privilege; encrypt refresh tokens; separate connected-account credentials; require explicit approval for
consequential actions; maintain immutable audit records; validate every tool argument with Zod; rate-limit webhooks;
verify webhook signatures/secrets where supported; treat message/email content as untrusted data; protect against
prompt injection.

The AI must never be allowed to decide 'send' merely because an email tells it to. External content can suggest
actions, but only the user or deterministic policy can authorize them.

25. Testing Strategy

Unit-test provider normalization, classification, account routing, approval state transitions and tool validation.
Integration-test OAuth, message fetch, draft and send. End-to-end test: interview email in spam ﬁ detected ﬁ
Telegram alert ﬁ draft ﬁ approval ﬁ send ﬁ audit log.

Create adversarial tests: malicious email instructions, wrong mailbox selection, spoofed sender, attachment
mismatch, duplicate webhook, expired approval, model hallucinated recipient, and accidental destructive action.

26. Deployment Strategy

Develop locally first. Deploy the same container/app to Railway. Supabase remains the database. For Gmail push,
Google requires Cloud Pub/Sub: create a topic, grant Gmail publish permission, create a subscription, and renew
each mailbox watch at least every 7 days; Google recommends renewing daily. Notifications can be delayed or
dropped, so keep a reconciliation/sync fallback. (Google Gmail API documentation)

27. Cost Strategy

Start with free tiers. Keep the AI provider swappable. Use Gemini initially if its free quota is adequate. Do not buy
OpenAI/Anthropic credits until measured usage or capability gaps justify them. Your first recurring cost should ideally
be zero or very small; Railway may become the first infrastructure charge as usage grows.

28. Definition of Done — MVP

You can connect all three Gmail accounts; a new important email from any account triggers a Telegram alert;
spam/other configured folders are included in the scan strategy; the alert identifies the source mailbox; you can
request a summary; you can request a draft; the assistant can find approved context/documents; it shows the draft;
'send it' sends from the correct account only after explicit approval; all actions are logged; a scheduled digest works.

29. Recommended Build Sequence at a Glance

1 Accounts/secrets ﬁ 2 skeleton ﬁ 3 Telegram ﬁ 4 DB ﬁ 5 one Gmail OAuth ﬁ 6 message sync ﬁ 7 classifier ﬁ 8
Telegram alerts ﬁ 9 drafts ﬁ 10 approval/send ﬁ 11 three Gmail accounts ﬁ 12 spam/other-folder reconciliation ﬁ
13 voice ﬁ 14 Zoho ﬁ 15 Outlook ﬁ 16 Calendar ﬁ 17 Drive ﬁ 18 morning briefs ﬁ 19 structured memory ﬁ 20
Linear ﬁ 21 WhatsApp ﬁ 22 local Apple companion ﬁ 23 meetings.

30. .env.example Reference

DATABASE_URL=
TELEGRAM_BOT_TOKEN=
GEMINI_API_KEY=
APP_BASE_URL=
ENCRYPTION_KEY=
SESSION_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=
MS_CLIENT_ID= # later
MS_CLIENT_SECRET= # later
MS_TENANT_ID= # later
ZOHO_CLIENT_ID= # later
ZOHO_CLIENT_SECRET= # later
LINEAR_API_KEY= # later

