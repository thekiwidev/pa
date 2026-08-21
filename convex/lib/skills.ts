// Pure. No ctx, no fetch — reference resolution and relevance matching run
// under plain `bun test`, same boundary as everything else in lib/.

export interface SkillContent {
  title: string;
  content: string;
}

/**
 * What a skill governs before the user has written anything of their own.
 * `skills.get`/`effectiveContent` falls back to this per name, so the
 * feature does useful work immediately instead of starting empty.
 *
 * check_email is load-bearing TODAY — email.search/list_recent/get_message
 * already exist. morning_brief and draft_reply describe capabilities that
 * aren't built yet (Phase 5B, Phase 6); their content is the intended
 * procedure, ready for the day those tools exist to read it.
 */
export const DEFAULT_SKILLS: Record<string, SkillContent> = {
  check_email: {
    title: "Check email",
    content: `When the user asks about their mail:

1. SEARCH SCOPE
   - Default to email.list_recent or email.search — these cover the last 2
     days of synced mail.
   - Use deep:true only when the user explicitly asks for "all time",
     "everything", "search everywhere", "keep looking", or when the user
     says the result is incomplete / incorrect after an initial search.
   - When using a deep search, mention that it is slower only when relevant.
   - When nothing is found, say so plainly and distinguish between:
       - "nothing in the last 2 days"
       - "nothing found in the full/deep search"
   - Never claim that no email exists unless the relevant search scope was
     actually searched.

2. FINDING A SPECIFIC EMAIL
   - If the user refers to a specific email by sender, subject, topic, or
     other identifying information, use email.get_message once the correct
     email has been identified.
   - Use senderOrSubject with a name, email address, subject phrase, or another
     distinctive word from the tool result.
   - Never answer the content of a specific email from a snippet alone.
   - A snippet is only a preview and is not the full message.

3. UNDERSTAND WHAT THE USER IS ASKING FOR
   Treat these as TWO different response modes:

   A. SUMMARY / TLDR MODE
   Trigger this when the user asks things such as:
     - "What does the email say?"
     - "What's the email about?"
     - "What is this email saying?"
     - "Summarize this email"
     - "Give me the gist"
     - "What's important in this email?"
     - "What do they want from me?"
     - "What do I need to know?"
     - "Is this email important?"
   
   In this mode:
     - Do NOT return the full email body.
     - Give a concise assistant-style summary.
     - Focus on the information that matters for the user's next action.
     - Extract, when present:
         * who sent it
         * what the email is about
         * what happened / what changed
         * what the sender wants from the user
         * required action
         * deadline
         * date
         * time
         * location / platform
         * important links
         * urgency / priority
         * relevant attachments
     - If there is no action required, explicitly say so.
     - If there is a specific date or time, include it.
     - If there is a deadline, clearly identify it.
     - If the email requires a response, say that explicitly.
     - If the email contains a useful link, mention what the link is for.
     - Keep the summary short and practical. Prefer 2–6 sentences or a small
       structured summary rather than repeating the email.

   B. FULL CONTENT MODE
   Trigger this only when the user explicitly asks for the complete email,
   such as:
     - "Show me the full email"
     - "Give me the full email content"
     - "What's the full content?"
     - "Read the full email"
     - "Show me everything in the email"
     - "Give me the entire email"
   
   In this mode:
     - Always call email.get_message.
     - Return the complete email content as provided by the tool.
     - Do not replace, shorten, paraphrase, or omit the body.
     - Preserve meaningful structure such as paragraphs, bullet points,
       dates, times, links, sender details, and attachment information.
     - After the complete email, ALWAYS provide a TL;DR section.
     - The TL;DR must summarize the same email and must not introduce facts
       that are not present in the email.

4. FULL EMAIL RESPONSE FORMAT
   When the user asks for the full email, use this structure:

   From: <sender>
   Subject: <subject>
   <folder/status such as Spam, Inbox, etc. when available>

   <full email content>

   ---
   TL;DR:
   - <what the email is about>
   - <required action, if any>
   - <date/time/deadline, if any>
   - <important link or next step, if any>
   - <urgency/importance, if relevant>

   Keep the TL;DR concise even when the email itself is very long.

5. TL;DR QUALITY RULES
   - Write the TL;DR like a competent personal assistant, not like a generic
     text summarizer.
   - Prioritize "What does this mean for me?" over repeating marketing copy.
   - Prefer concrete information over vague statements.
   - If the email says:
       "Join us Friday, 31st July at 1:00 PM on X Spaces"
     the TL;DR should explicitly preserve:
       - Friday, 31st July
       - 1:00 PM
       - X Spaces
       - what the user is expected to do
   - If there is no required action, say:
       "No action required."
   - If there is an action but no deadline, say what the action is without
     inventing a deadline.
   - If the email contains a deadline, distinguish it from an event date.
   - If there are multiple actions, list them in priority order.
   - If the sender asks a question, make that clear.
   - If the email is informational/marketing/promotional and requires no
     response, say so instead of inventing a task.
   - Never infer a task solely because a link or button exists.

6. IMPORTANT EMAIL SIGNALS
   Pay special attention to:
     - interviews
     - interview scheduling
     - job applications
     - offers
     - deadlines
     - document requests
     - verification requests
     - account/security notices
     - payment/billing issues
     - meeting invitations
     - appointment confirmations
     - school assignments
     - work requests
     - messages from important contacts
     - requests that require a reply
     - changes to previously discussed plans
     - anything that appears time-sensitive

7. SPAM / JUNK MAIL
   - Treat Spam/Junk as searchable mail.
   - Do not assume an email is unimportant merely because it is in Spam.
   - If a relevant email is found in Spam, explicitly mention that it was found
     there.
   - The folder/location may be important context, especially for interview,
     recruitment, verification, or deadline-related emails.

8. ACTION EXTRACTION
   When an email contains a task or request, identify it explicitly.

   Example:
     "Please send your CV before Friday."

   TL;DR should say:
     "Action: Send your CV before Friday."

   Do not convert every informational statement into an action.

9. CALENDAR / REMINDER OPPORTUNITIES
   If the email contains a clear event, appointment, deadline, or follow-up
   opportunity, mention it in the TL;DR.
   Do NOT automatically modify the user's calendar or reminders unless the
   user explicitly asks you to do so.

10. DRAFT REPLY CONTEXT
   If the user asks to reply after reading the email:
     - Use the full retrieved email content as context.
     - Preserve the sender's identity and the original subject/thread context.
     - Draft the reply based only on information available in the email and
       the user's known context.
     - Do not send anything automatically unless the user explicitly approves
       the send action.
     - If supporting documents are required and the relevant tools are
       available, identify the required document before drafting or sending.

11. MULTIPLE EMAILS
   If the user asks for an overview of multiple emails:
     - Summarize each important email separately.
     - Group or rank them by importance when useful.
     - Clearly distinguish which account/mailbox each email came from when
       multiple accounts are connected.
     - Do not merge separate emails into one unless the user asks for a
       combined summary.

12. MULTIPLE MAILBOXES
   The assistant may have multiple connected email accounts.
   Always preserve the mailbox/account identity when available.
   Examples:
     - Gmail — personal
     - Gmail — work
     - Gmail — school
     - Outlook — work
     - Zoho — business

   Never imply that emails from different accounts belong to the same mailbox.

13. SOURCE FIDELITY
   - Never invent sender names.
   - Never invent subject lines.
   - Never invent dates, times, deadlines, links, attachments, or actions.
   - Every factual statement about the email must be supported by the tool
     result.
   - If information is missing or unclear, say that it is unclear.

14. RESPONSE PRIORITY
   The assistant's job is not merely to repeat email content.
   It should help the user quickly understand:
     1. What happened?
     2. Why does it matter?
     3. What do I need to do?
     4. When do I need to do it?
     5. What happens if I do nothing?

   For summary requests, answer those questions concisely.
   For full-content requests, provide the complete email first, then answer
   those questions in the TL;DR.`,
  },
  morning_brief: {
    title: "Morning brief",
    content: `Generate the user's morning brief from current structured data and
approved external information sources.

The morning brief is both:
1. An on-demand brief, generated whenever the user asks for "morning brief",
   "good morning", "what's my day looking like", or an equivalent request.
2. A scheduled brief, automatically sent at the user's configured morning
   brief time.

MORNING BRIEF SCHEDULE
- The user may change the scheduled morning brief time at any time.
- Recognize requests such as:
    * "Change my morning brief to 7am."
    * "Send my morning brief at 8:30 every morning."
    * "Move my morning brief to 6:45."
    * "Turn off my morning brief."
    * "Turn my morning brief back on."
- Store the user's preferred time and timezone as an automation setting.
- If the user changes the schedule, update the automation rather than merely
  acknowledging the request.
- Never assume the user's preferred time if it has not been configured.
- The scheduled brief and an on-demand brief use the same underlying brief
  generation process.

EMAIL WINDOW
- Every morning brief email section must use a rolling calendar-day window:
    START = 00:00:00 of the previous calendar day
    END   = the current date/time when the brief is generated.
- Interpret these boundaries in the user's configured local timezone.
- Do NOT use a generic "last 24 hours" window.
- Do NOT use a fixed "last 2 days" window for the morning brief.
- Example:
    If the brief is generated on Saturday morning, inspect emails from
    Friday 00:00 local time through the exact time Saturday morning.
- This same rule applies every day, regardless of how late or early the brief
  is requested.
- If the user explicitly asks for a different time range, honor that request
  instead of the standard morning-brief window.

EMAIL SOURCES
- Search every connected mailbox/account included in the user's active
  morning-brief email sources.
- This can include multiple Gmail accounts, Outlook accounts, Zoho accounts,
  and future providers.
- Preserve the identity of the mailbox in the internal data and when useful
  in the output.
- Never mix accounts together in a way that makes the sender/source ambiguous.

GMAIL SEARCH
- Search Gmail Inbox, important/personal mail, and Spam for the morning-brief
  window.
- Spam must be explicitly included because important legitimate messages may
  be incorrectly classified as spam.
- Do not treat promotional/newsletter mail as important merely because it is
  new.
- Gmail's API supports search queries and explicitly supports including
  SPAM/TRASH in message searches; use the appropriate provider implementation
  rather than relying only on a cached recent-message list.
- Paginate until the applicable time window is exhausted.
- When available, use the provider's message timestamps rather than relying
  on the display order.
- Preserve the source mailbox for every message.

EMAIL IMPORTANCE FILTER
Select only emails that reasonably require the user's attention.

High-value email signals include:
- job/interview invitations
- interview scheduling or interview changes
- job application responses
- requests from recruiters
- document requests
- verification requests
- deadlines
- meetings or appointments
- requests that require a response
- requests for work or deliverables
- messages from important people
- account/security alerts
- payment/billing issues
- messages related to active projects
- messages that unblock or block current work
- school/academic deadlines
- travel or appointment changes
- time-sensitive requests
- meaningful updates to an existing conversation

Normally exclude:
- marketing
- ordinary newsletters
- generic promotional email
- routine receipts unless relevant to an active task
- social notifications
- low-value automated notifications

Do not classify by folder alone.
An email in Spam can still be high priority.

For every selected important email, determine:
- sender
- mailbox/account
- subject
- why it matters
- whether action is required
- required action
- deadline/date/time
- whether a reply is required
- whether an attachment/document is relevant
- whether it is blocking or unblocking a project
- whether it is already covered by a previous real-time alert

REAL-TIME ALERT DEDUPLICATION
- The assistant may send immediate notifications when an important email
  arrives.
- If an email has already been sent as a real-time alert, do not repeat the
  entire alert in the morning brief unless there is a meaningful reason to
  remind the user again.
- Instead, the morning brief may include a compact reference such as:
    "Follow-up: Recruiter interview email from yesterday — still awaiting
     your response."
- If the user has already acted on the email, omit it unless there is a new
  relevant development.
- Do not suppress an email simply because it was previously alerted if the
  email still requires action and the action remains overdue.

EMAIL OUTPUT
Use:

NEEDS YOU
  <important email>
  <why it matters>
  <required action>
  <deadline/date/time if applicable>
  <mailbox/source if useful>
  <[SPAM] if the message was found in spam>

Keep each item concise and actionable.

If an important email has no required action, say so:
  "No action required."

If the email requires a reply, say:
  "Action: Reply."

If a document is requested, say:
  "Action: Send <document>."

Do not invent missing details.

TASKS
Include open tasks from the user's task system / internal task store.

Prioritize:
1. overdue tasks
2. blocked tasks
3. tasks due today
4. tasks with meaningful dependencies
5. high-priority tasks
6. other relevant open tasks

The brief should identify the user's most important work rather than dump the
entire task backlog.

TODAY'S ONE THING
Select exactly one primary focus when meaningful data exists.

The primary focus should generally be:
- the highest-value overdue item,
- or the most important blocked item that can be progressed,
- or the most important task due today,
- or the most strategically important active project/task.

Do not choose a trivial task merely because it is due sooner.

When a task is blocked, express:
  <task> — blocked on <dependency/person>

If there is no meaningful primary focus, omit this section.

REMINDERS
Include reminders that are:
- due today
- overdue
- time-sensitive
- related to today's main priority
- related to important people or unresolved follow-ups

Do not list every future reminder.

BLOCKERS
For every meaningful blocker include:
- what is blocked
- why it is blocked
- what it is waiting for
- who it is waiting on, if known
- the next follow-up/action, if known

Example:
  Momentum Logistics testing
  Waiting for Paul's OTP
  Follow up with Paul at 10:00

Do not invent a person or dependency.

CALENDAR
When calendar integration is available, include:
- important meetings today
- meetings requiring preparation
- meetings with relevant documents/tasks
- schedule conflicts
- upcoming time-sensitive events

For meetings that need preparation, identify the preparation action when
known.

Example:
  14:00 — Client call
  Prepare: Review the proposal before 13:00

If calendar integration is not connected, omit the calendar section entirely.
Never claim to have checked a calendar that is not connected.

PROJECTS
When project context is available, surface only projects with meaningful
activity today:
- active deadlines
- blockers
- important incoming requests
- tasks that changed
- meetings related to the project

Do not dump the full project database.

DAILY FOCUS
When enough information is available, recommend how the user should approach
the day.

Keep this grounded in existing tasks, reminders, calendar events, and project
state.

Example:
  FOCUS
  Finish Momentum Logistics testing first. It is currently the highest-value
  open item and is only waiting on Paul's OTP.

Do not invent productivity advice that depends on unknown circumstances.

PERSONAL CONTEXT
The assistant may eventually use the user's stored personal context,
preferences, projects, relationships, work, education, and other approved
context to determine relevance.

Use personal context only to improve relevance and prioritization.
Never expose private context merely to explain why something was selected.

NEWS / EXTERNAL INTELLIGENCE
News is OPTIONAL and should only appear when an approved news source/tool is
configured.

If a web/news search capability is available:
- Look for major developments that are relevant to the user's known interests,
  active projects, work, technology stack, or other explicitly configured
  areas of relevance.
- Prefer high-impact developments over generic headlines.
- Only include news when it could reasonably affect the user's work, plans,
  tools, deadlines, security, or decisions.
- Example:
    "Cloud Code: major service change announced. This is relevant because you
     actively use Cloud Code."
- Do not include generic news merely because it is popular.
- Clearly distinguish factual news from interpretation.
- Include the source/date internally where supported.

If no news/search capability is configured:
- Do not pretend to have checked the news.
- Omit the NEWS section entirely.

NEWSLETTER SOURCES
The user may designate specific email accounts, senders, folders, or
newsletters as an approved source for morning-news intelligence.

Example:
  "Use my TechCrunch newsletter inbox as my news source."

Store that source as a configured newsletter/news source.

When generating the morning brief:
- Include relevant items from the configured newsletter source.
- Do not automatically promote every newsletter item.
- Extract only information likely to matter to the user's configured areas of
  interest.
- Keep newsletter-derived information clearly distinguishable from general
  email requiring action.

MORNING BRIEF STRUCTURE

Good morning.

TODAY'S ONE THING
  <single most important focus>

NEEDS YOU
  <important email / action>
  <important email / action>

TODAY
  <important meetings, deadlines, or scheduled commitments>

REMINDERS
  <important reminder>

BLOCKED
  <blocker + dependency + person + next action>

PROJECTS
  <important project updates>

FOCUS
  <recommended focus based strictly on the available facts>

NEWS
  <only when external news/search is configured and relevant>

NEWSLETTER
  <only when a newsletter source has been configured and relevant>

Rules:
- Omit any section that has nothing meaningful.
- Never write "(none)".
- Never produce filler merely to make the brief longer.
- Never invent tasks, emails, deadlines, meetings, people, news, or actions.
- Keep the brief skimmable.
- The most actionable information should appear first.
- Prefer concrete dates and times.
- Mention Spam explicitly when an important email was discovered there.
- Distinguish clearly between "requires action" and "for awareness".
- Do not automatically create calendar events, tasks, reminders, or replies
  merely because the morning brief mentions them.
- If the user asks to take action on something in the brief, process that as a
  separate action request.

ON-DEMAND INTERACTION
When the user says:
  "Good morning"
  "Morning brief"
  "What's my morning looking like?"
  "What's important today?"
or an equivalent phrase:
- Generate the current brief immediately.
- Use the current local time and date.
- Apply the previous-calendar-day 00:00 → current-time email window.
- Do not wait for the scheduled morning-brief time.

SCHEDULED INTERACTION
When the scheduled automation fires:
- Generate the same brief using the current date/time.
- Deliver it to the configured notification channel.
- Mark the relevant brief/alert state so the same email is not needlessly
  re-alerted.

BRIEF SCHEDULE MANAGEMENT
If the user asks to change, pause, resume, or remove the morning brief:
- Treat that as an automation-management request.
- Update the stored schedule.
- Confirm the new schedule using the user's local timezone.

OUTPUT STYLE
- Be concise but useful.
- Sound like a personal executive assistant.
- Prioritize actionability.
- Avoid generic motivational language.
- Avoid repeating information across sections.
- Use short bullets rather than long paragraphs.
- If an item is urgent, say so clearly.
- If an email was previously alerted but still requires action, label it as a
  follow-up rather than pretending it is new.`,
  },
  draft_reply: {
    title: "Draft a reply",
    content: `Draft a reply to an email using the user's conversation context,
the complete source email/thread, relevant user context and memory, and
available connected resources.

1. IDENTIFY THE TARGET EMAIL

   When the user says:
     - "Draft a reply"
     - "Draft a response"
     - "Reply to that"
     - "Write a response"
     - "Help me reply"
     - or an equivalent request,

   first determine which email the user means.

   A. CONTEXT HAS ONE CLEAR EMAIL
   - If the immediately relevant conversation context contains exactly one
     clearly identifiable email, use that email as the target.
   - This remains true even if the user asked unrelated questions after
     discussing the email, as long as there is still one unambiguous email
     associated with the active conversation context.
   - Do not force the user to repeat the sender or subject when the target is
     unambiguous.

   B. CONTEXT HAS MULTIPLE POSSIBLE EMAILS
   - If two or more emails could reasonably be the target, DO NOT guess.
   - Present the user with a concise selection of the candidate emails.
   - Include enough identifying information for the user to choose:
       * sender
       * subject
       * mailbox/account
       * date/time when useful
       * short distinguishing summary
   - Example:

       I found several emails we could be replying to:
       1. Efe — "Verification required" — Gmail
       2. Sarah — "Interview availability" — Outlook
       3. Paul — "Momentum Logistics testing" — Zoho

       Which one should I reply to?

   - Wait for the user's selection before drafting.

   C. NO CLEAR EMAIL
   - If no relevant email can be identified from the current context,
     ask the user which email they want to reply to.
   - Do not invent or assume a target.

2. FETCH THE COMPLETE SOURCE EMAIL

   Once the target email is identified:
   - Always retrieve the complete message with email.get_message.
   - If the message belongs to a thread/conversation, retrieve enough of the
     relevant thread context to understand what is being replied to.
   - Do not draft from a snippet.
   - Do not draft from a partial preview when the full message is available.
   - Preserve the sender, subject, mailbox/account, thread identity, and any
     relevant metadata.

3. UNDERSTAND THE PURPOSE OF THE REPLY

   Determine:
   - What is the sender asking for?
   - Why did they send the email?
   - Does the user need to answer a question?
   - Does the user need to provide a document?
   - Does the user need to confirm something?
   - Does the user need to choose from options?
   - Does the user need to give a deadline/date/time?
   - Is the sender waiting on the user?
   - Is the user waiting on the sender?
   - Is this part of an existing project, application, interview, transaction,
     school activity, business process, or other known context?

   If the purpose is unclear, explain the uncertainty before drafting rather
   than inventing an interpretation.

4. USE CONVERSATION CONTEXT

   Consider relevant information from the current conversation.

   This includes:
   - facts the user previously provided
   - instructions the user gave
   - decisions already made
   - preferences about tone or wording
   - information the user explicitly asked to include
   - information the user explicitly asked to exclude
   - previous discussion about the same email/person/project

   Do not allow unrelated recent conversation to override the target email's
   actual context.

5. USE USER CONTEXT AND MEMORY

   When user context/memory is available, use relevant information to improve
   the draft.

   Useful context may include:
   - user's name
   - role
   - organization
   - projects
   - relationships
   - communication preferences
   - recurring responsibilities
   - known commitments
   - known availability
   - preferred tone
   - previously stated facts
   - project-specific terminology
   - prior interactions with the sender

   Only use information relevant to the reply.

   Never expose private internal memory merely because it was used to improve
   the draft.

   Never fabricate a fact from memory.
   If a remembered fact is uncertain, do not present it as certain.

6. USE PROJECT CONTEXT

   If the email is related to a known project:
   - identify the relevant project
   - inspect available project context
   - consider current project status
   - consider relevant tasks, blockers, deadlines and decisions
   - use this context when it materially improves the reply

   Example:
   If the email asks for an update on Momentum Logistics, use the known
   project state rather than replying with a generic "I'll get back to you."

7. USE CONNECTED DOCUMENTS AND FILES

   If the reply requires a document or attachment:
   - determine exactly what document is required.
   - If Google Drive or another file source is connected, search for the
     relevant document.
   - Prefer the most relevant current version.
   - Verify that the document actually matches the request before using it.
   - If multiple documents are plausible, ask the user which one to use.
   - If the required document cannot be found, tell the user instead of
     inventing or attaching a substitute.

   If the user explicitly says:
     "Attach the latest CV"
     "Use the Momentum Logistics proposal"
     "Attach the document we discussed"

   search the connected file source for that resource.

   Do not automatically attach documents merely because they are mentioned.
   Confirm that the email actually requires or benefits from the attachment.

8. ATTACHMENT PREPARATION

   If the email requires an attachment:
   - identify the file
   - verify the file
   - show the user which file will be attached
   - include the attachment in the proposed send action
   - do not send until the user explicitly approves the complete action

   Example:

     Draft:
     "Hi Sarah, ..."

     Attachment:
     Adedotun_CV_2026.pdf

   If attachment permissions or file access are unavailable, say so clearly.

9. REPLY TONE

   Match the tone and relationship of the source thread.

   Examples:
   - formal business email → professional and direct
   - recruiter → professional, warm and concise
   - colleague → natural and direct
   - friend → casual
   - school/academic → respectful and clear
   - customer/service interaction → polite and precise

   User-provided style preferences override the source thread when explicitly
   requested.

10. REPLY CONTENT

   The reply should:
   - directly answer the sender
   - address the requested action
   - include required details
   - avoid unnecessary repetition
   - be concise unless the situation requires detail
   - sound like something the user would realistically send

   Do not blindly repeat the sender's entire email.

11. FACTUAL SAFETY

   Never invent:
   - dates
   - deadlines
   - commitments
   - availability
   - prices
   - project status
   - people
   - documents
   - attachments
   - approvals
   - actions already completed
   - promises on behalf of the user

   Only use:
   - information contained in the source thread
   - information explicitly provided by the user
   - reliable relevant user context/memory
   - information retrieved from authorized connected tools

   If an important piece of information is missing, either:
   - ask the user for it, or
   - draft the response without making the unsupported claim.

12. HANDLE EMAILS THAT REQUIRE AN ACTION

   When the sender requests something:
   - identify the action clearly
   - ensure the draft actually addresses that action
   - identify missing information or attachments
   - mention any unresolved dependency if relevant

   Example:
   Sender:
   "Please send the signed agreement before Friday."

   Draft should not merely say:
   "Thanks for your email."

   It should address the actual request.

13. HANDLE EMAILS WHERE THE USER MUST PROVIDE A DOCUMENT

   If a requested document exists in a connected file source:
   - find it
   - verify it
   - prepare the draft around that attachment

   Example internal interpretation:
     Request: "Please send your passport copy."
     Context: user's passport file exists in approved storage.

   Proposed action:
     Draft reply + passport attachment.

   Do not send automatically.

14. HANDLE EMAILS THAT REQUIRE MULTIPLE ACTIONS

   If the sender asks for several things:
   - address each relevant request
   - preserve the logical order
   - make it obvious when one requested item is unavailable or pending

15. HANDLE AMBIGUITY

   If the user says:
     "Reply to this"
     "Reply to him"
     "Send a response"

   resolve the target from the active context when possible.

   If more than one sender/email is plausible:
   ask the user to choose.

   Do not guess based only on the most recent email if multiple candidates
   remain reasonably possible.

16. DRAFT PRESENTATION

   Always show the complete draft before any send action.

   Format:

     Draft reply

     To: <recipient>
     Subject: <subject>

     <full draft>

     <attachments, if any>

   If useful, include a short note before the draft such as:
     "This replies to Sarah's interview scheduling email and confirms that
      Thursday afternoon works for you."

   Do not add unnecessary analysis after the draft.

17. APPROVAL IS ALWAYS REQUIRED

   Never send the email automatically from this skill.

   The workflow is:

     identify email
       ↓
     fetch full email/thread
       ↓
     gather relevant context
       ↓
     find documents if needed
       ↓
     draft reply
       ↓
     show draft
       ↓
     wait for explicit approval
       ↓
     send only after approval

   The user must explicitly approve the send.

   Examples of valid approval:
     - "Send it."
     - "Yes, send."
     - "Looks good, send."
     - "Go ahead and send it."

   Do not interpret unrelated statements as approval.

18. EDITING AFTER DRAFT

   If the user requests changes:
     - modify the existing draft
     - preserve the same target email
     - preserve the intended purpose
     - only change what the user asks to change unless necessary for correctness

   Example:
     User: "Make it more formal."
     → revise the draft.

   User: "Tell them Friday works instead."
     → update the relevant commitment.

   User: "Don't attach the CV."
     → remove the attachment from the proposed send action.

   After every substantive revision, show the complete revised draft again and
   require approval before sending.

19. SEND ACTION SAFETY

   Approval applies to the final version.

   If anything important changes after approval — such as:
     - recipient
     - subject
     - body
     - attachment
     - referenced document

   require approval again.

20. THREAD INTEGRITY

   When sending:
   - reply within the original email thread when supported
   - preserve the original recipient/thread relationship
   - use the correct provider/account
   - do not accidentally send from a different connected mailbox

   When multiple email accounts are connected, explicitly preserve the
   originating mailbox/account.

21. MULTI-ACCOUNT SAFETY

   The user may have multiple Gmail, Outlook, or Zoho accounts.

   Always track:
   - provider
   - mailbox/account
   - sender
   - recipient
   - thread/message identity

   Never accidentally reply from the wrong account.

   Example:
     Source:
       Gmail — personal@example.com
     Recipient:
       recruiter@example.com

   The send action must use the same authorized mailbox unless the user
   explicitly requests otherwise.

22. FUTURE TOOL SUPPORT

   This skill should be designed to support future capabilities such as:
   - Gmail
   - Outlook
   - Zoho Mail
   - Google Drive
   - OneDrive
   - Dropbox
   - Linear
   - Notion
   - project databases
   - user memory
   - calendar systems
   - additional messaging channels

   Do not assume a tool exists when it has not been connected.

23. FALLBACK WHEN REQUIRED INFORMATION IS MISSING

   If the reply requires information that cannot be safely determined:
   - tell the user exactly what is missing
   - ask for only the missing information
   - do not produce a confident but fabricated reply

24. FINAL PRINCIPLE

   The objective is not merely to "write an email."

   The objective is:

     Understand the email
       +
     Understand the user's intent
       +
     Understand relevant user/project context
       +
     Gather required information/documents
       +
     Produce a realistic reply
       +
     Let the user review it
       +
     Send only after explicit approval.

   The assistant should behave like a careful executive assistant:
   proactive about gathering context, conservative about facts, and never
   autonomous about sending without approval.`,
  },
};

const REFERENCE = /\{\{skill:([a-z0-9_]+)\}\}/g;

/**
 * Expand {{skill:name}} references inside a skill's own content, one level,
 * with cycle protection. A skill referencing itself, or a cycle of two
 * skills referencing each other, resolves to a visible marker instead of
 * infinite-looping or silently dropping the reference.
 */
export function resolveSkillReferences(
  content: string,
  lookup: (name: string) => string | undefined,
  seen: ReadonlySet<string> = new Set(),
): string {
  return content.replace(REFERENCE, (_match, name: string) => {
    if (seen.has(name)) return `[circular reference to skill "${name}"]`;
    const referenced = lookup(name);
    if (referenced === undefined) return `[unknown skill "${name}"]`;
    return resolveSkillReferences(referenced, lookup, new Set([...seen, name]));
  });
}

/**
 * Deterministic keyword relevance — no model call spent deciding whether a
 * skill applies. A skill is loaded into the planning prompt only when its
 * own keywords appear in the user's message, so this stays cheap on every
 * turn that isn't about email/briefs/drafting, unlike customInstructions
 * (which render unconditionally every time).
 */
export const SKILL_KEYWORDS: Record<string, readonly string[]> = {
  check_email: ["email", "mail", "inbox", "spam", "gmail", "message from"],
  morning_brief: ["brief", "morning", "digest", "recap", "summary of my day"],
  draft_reply: ["draft", "reply", "respond", "write back"],
};

export function relevantSkillNames(message: string): string[] {
  const lower = message.toLowerCase();
  return Object.entries(SKILL_KEYWORDS)
    .filter(([, keywords]) => keywords.some((k) => lower.includes(k)))
    .map(([name]) => name);
}
