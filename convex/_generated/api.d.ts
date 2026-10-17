/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as ai_embed from "../ai/embed.js";
import type * as ai_providers_anthropic from "../ai/providers/anthropic.js";
import type * as ai_providers_gemini from "../ai/providers/gemini.js";
import type * as ai_providers_openai from "../ai/providers/openai.js";
import type * as ai_providers_openrouter from "../ai/providers/openrouter.js";
import type * as ai_registry from "../ai/registry.js";
import type * as ai_types from "../ai/types.js";
import type * as assistant from "../assistant.js";
import type * as briefs from "../briefs.js";
import type * as channels_telegram from "../channels/telegram.js";
import type * as checkins from "../checkins.js";
import type * as connectors_gcal_client from "../connectors/gcal/client.js";
import type * as connectors_gdrive_client from "../connectors/gdrive/client.js";
import type * as connectors_gmail_client from "../connectors/gmail/client.js";
import type * as connectors_gmail_normalize from "../connectors/gmail/normalize.js";
import type * as connectors_gmail_oauth from "../connectors/gmail/oauth.js";
import type * as connectors_google_jwt from "../connectors/google/jwt.js";
import type * as connectors_linear_client from "../connectors/linear/client.js";
import type * as connectors_notion_client from "../connectors/notion/client.js";
import type * as connectors_social_client from "../connectors/social/client.js";
import type * as crons from "../crons.js";
import type * as debug from "../debug.js";
import type * as gmail from "../gmail.js";
import type * as http from "../http.js";
import type * as lib_ai_errors from "../lib/ai/errors.js";
import type * as lib_ai_prompt from "../lib/ai/prompt.js";
import type * as lib_ai_resolve from "../lib/ai/resolve.js";
import type * as lib_ai_routes from "../lib/ai/routes.js";
import type * as lib_ai_tiers from "../lib/ai/tiers.js";
import type * as lib_assistant_claims from "../lib/assistant/claims.js";
import type * as lib_assistant_refs from "../lib/assistant/refs.js";
import type * as lib_calendar_availability from "../lib/calendar/availability.js";
import type * as lib_calendar_calendars from "../lib/calendar/calendars.js";
import type * as lib_calendar_events from "../lib/calendar/events.js";
import type * as lib_calendar_meetingFlow from "../lib/calendar/meetingFlow.js";
import type * as lib_calendar_window from "../lib/calendar/window.js";
import type * as lib_capture_batch from "../lib/capture/batch.js";
import type * as lib_config from "../lib/config.js";
import type * as lib_drive_query from "../lib/drive/query.js";
import type * as lib_email_classification from "../lib/email/classification.js";
import type * as lib_email_draftBody from "../lib/email/draftBody.js";
import type * as lib_email_gmailQuery from "../lib/email/gmailQuery.js";
import type * as lib_email_markdownToEmailHtml from "../lib/email/markdownToEmailHtml.js";
import type * as lib_email_prefilter from "../lib/email/prefilter.js";
import type * as lib_email_priority from "../lib/email/priority.js";
import type * as lib_email_pubsub from "../lib/email/pubsub.js";
import type * as lib_email_recipients from "../lib/email/recipients.js";
import type * as lib_email_rules from "../lib/email/rules.js";
import type * as lib_json from "../lib/json.js";
import type * as lib_linear_apiKey from "../lib/linear/apiKey.js";
import type * as lib_meetings_transcript from "../lib/meetings/transcript.js";
import type * as lib_net_sniff from "../lib/net/sniff.js";
import type * as lib_net_urlGuard from "../lib/net/urlGuard.js";
import type * as lib_notion_blocks from "../lib/notion/blocks.js";
import type * as lib_notion_links from "../lib/notion/links.js";
import type * as lib_notion_lists from "../lib/notion/lists.js";
import type * as lib_ops_health from "../lib/ops/health.js";
import type * as lib_ops_incident from "../lib/ops/incident.js";
import type * as lib_personas from "../lib/personas.js";
import type * as lib_prompts_assistant from "../lib/prompts/assistant.js";
import type * as lib_prompts_brief from "../lib/prompts/brief.js";
import type * as lib_prompts_format from "../lib/prompts/format.js";
import type * as lib_prompts_knowledge from "../lib/prompts/knowledge.js";
import type * as lib_saved_extract from "../lib/saved/extract.js";
import type * as lib_saved_note from "../lib/saved/note.js";
import type * as lib_saved_rank from "../lib/saved/rank.js";
import type * as lib_scope from "../lib/scope.js";
import type * as lib_skills from "../lib/skills.js";
import type * as lib_social_detect from "../lib/social/detect.js";
import type * as lib_social_parse from "../lib/social/parse.js";
import type * as lib_social_sources from "../lib/social/sources.js";
import type * as lib_tasks_backend from "../lib/tasks/backend.js";
import type * as lib_telegram_html from "../lib/telegram/html.js";
import type * as lib_telegram_richtext from "../lib/telegram/richtext.js";
import type * as lib_telegram_split from "../lib/telegram/split.js";
import type * as lib_time from "../lib/time.js";
import type * as lib_tools_catalog from "../lib/tools/catalog.js";
import type * as lib_tools_outcomes from "../lib/tools/outcomes.js";
import type * as lib_tools_plan from "../lib/tools/plan.js";
import type * as lib_types from "../lib/types.js";
import type * as lib_userContext from "../lib/userContext.js";
import type * as meetings from "../meetings.js";
import type * as model_approvals from "../model/approvals.js";
import type * as model_audit from "../model/audit.js";
import type * as model_briefConfig from "../model/briefConfig.js";
import type * as model_connectedAccounts from "../model/connectedAccounts.js";
import type * as model_drafts from "../model/drafts.js";
import type * as model_emailMessages from "../model/emailMessages.js";
import type * as model_emailRules from "../model/emailRules.js";
import type * as model_feedback from "../model/feedback.js";
import type * as model_instructions from "../model/instructions.js";
import type * as model_mediaGroups from "../model/mediaGroups.js";
import type * as model_meetings from "../model/meetings.js";
import type * as model_messages from "../model/messages.js";
import type * as model_noiseSenders from "../model/noiseSenders.js";
import type * as model_notifications from "../model/notifications.js";
import type * as model_oauthStates from "../model/oauthStates.js";
import type * as model_ops from "../model/ops.js";
import type * as model_people from "../model/people.js";
import type * as model_preferences from "../model/preferences.js";
import type * as model_projects from "../model/projects.js";
import type * as model_reminders from "../model/reminders.js";
import type * as model_saved from "../model/saved.js";
import type * as model_skills from "../model/skills.js";
import type * as model_tasks from "../model/tasks.js";
import type * as model_userContext from "../model/userContext.js";
import type * as model_users from "../model/users.js";
import type * as notify from "../notify.js";
import type * as ops from "../ops.js";
import type * as reminders from "../reminders.js";
import type * as saved from "../saved.js";
import type * as security_crypto from "../security/crypto.js";
import type * as security_hash from "../security/hash.js";
import type * as tools_router from "../tools/router.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "ai/embed": typeof ai_embed;
  "ai/providers/anthropic": typeof ai_providers_anthropic;
  "ai/providers/gemini": typeof ai_providers_gemini;
  "ai/providers/openai": typeof ai_providers_openai;
  "ai/providers/openrouter": typeof ai_providers_openrouter;
  "ai/registry": typeof ai_registry;
  "ai/types": typeof ai_types;
  assistant: typeof assistant;
  briefs: typeof briefs;
  "channels/telegram": typeof channels_telegram;
  checkins: typeof checkins;
  "connectors/gcal/client": typeof connectors_gcal_client;
  "connectors/gdrive/client": typeof connectors_gdrive_client;
  "connectors/gmail/client": typeof connectors_gmail_client;
  "connectors/gmail/normalize": typeof connectors_gmail_normalize;
  "connectors/gmail/oauth": typeof connectors_gmail_oauth;
  "connectors/google/jwt": typeof connectors_google_jwt;
  "connectors/linear/client": typeof connectors_linear_client;
  "connectors/notion/client": typeof connectors_notion_client;
  "connectors/social/client": typeof connectors_social_client;
  crons: typeof crons;
  debug: typeof debug;
  gmail: typeof gmail;
  http: typeof http;
  "lib/ai/errors": typeof lib_ai_errors;
  "lib/ai/prompt": typeof lib_ai_prompt;
  "lib/ai/resolve": typeof lib_ai_resolve;
  "lib/ai/routes": typeof lib_ai_routes;
  "lib/ai/tiers": typeof lib_ai_tiers;
  "lib/assistant/claims": typeof lib_assistant_claims;
  "lib/assistant/refs": typeof lib_assistant_refs;
  "lib/calendar/availability": typeof lib_calendar_availability;
  "lib/calendar/calendars": typeof lib_calendar_calendars;
  "lib/calendar/events": typeof lib_calendar_events;
  "lib/calendar/meetingFlow": typeof lib_calendar_meetingFlow;
  "lib/calendar/window": typeof lib_calendar_window;
  "lib/capture/batch": typeof lib_capture_batch;
  "lib/config": typeof lib_config;
  "lib/drive/query": typeof lib_drive_query;
  "lib/email/classification": typeof lib_email_classification;
  "lib/email/draftBody": typeof lib_email_draftBody;
  "lib/email/gmailQuery": typeof lib_email_gmailQuery;
  "lib/email/markdownToEmailHtml": typeof lib_email_markdownToEmailHtml;
  "lib/email/prefilter": typeof lib_email_prefilter;
  "lib/email/priority": typeof lib_email_priority;
  "lib/email/pubsub": typeof lib_email_pubsub;
  "lib/email/recipients": typeof lib_email_recipients;
  "lib/email/rules": typeof lib_email_rules;
  "lib/json": typeof lib_json;
  "lib/linear/apiKey": typeof lib_linear_apiKey;
  "lib/meetings/transcript": typeof lib_meetings_transcript;
  "lib/net/sniff": typeof lib_net_sniff;
  "lib/net/urlGuard": typeof lib_net_urlGuard;
  "lib/notion/blocks": typeof lib_notion_blocks;
  "lib/notion/links": typeof lib_notion_links;
  "lib/notion/lists": typeof lib_notion_lists;
  "lib/ops/health": typeof lib_ops_health;
  "lib/ops/incident": typeof lib_ops_incident;
  "lib/personas": typeof lib_personas;
  "lib/prompts/assistant": typeof lib_prompts_assistant;
  "lib/prompts/brief": typeof lib_prompts_brief;
  "lib/prompts/format": typeof lib_prompts_format;
  "lib/prompts/knowledge": typeof lib_prompts_knowledge;
  "lib/saved/extract": typeof lib_saved_extract;
  "lib/saved/note": typeof lib_saved_note;
  "lib/saved/rank": typeof lib_saved_rank;
  "lib/scope": typeof lib_scope;
  "lib/skills": typeof lib_skills;
  "lib/social/detect": typeof lib_social_detect;
  "lib/social/parse": typeof lib_social_parse;
  "lib/social/sources": typeof lib_social_sources;
  "lib/tasks/backend": typeof lib_tasks_backend;
  "lib/telegram/html": typeof lib_telegram_html;
  "lib/telegram/richtext": typeof lib_telegram_richtext;
  "lib/telegram/split": typeof lib_telegram_split;
  "lib/time": typeof lib_time;
  "lib/tools/catalog": typeof lib_tools_catalog;
  "lib/tools/outcomes": typeof lib_tools_outcomes;
  "lib/tools/plan": typeof lib_tools_plan;
  "lib/types": typeof lib_types;
  "lib/userContext": typeof lib_userContext;
  meetings: typeof meetings;
  "model/approvals": typeof model_approvals;
  "model/audit": typeof model_audit;
  "model/briefConfig": typeof model_briefConfig;
  "model/connectedAccounts": typeof model_connectedAccounts;
  "model/drafts": typeof model_drafts;
  "model/emailMessages": typeof model_emailMessages;
  "model/emailRules": typeof model_emailRules;
  "model/feedback": typeof model_feedback;
  "model/instructions": typeof model_instructions;
  "model/mediaGroups": typeof model_mediaGroups;
  "model/meetings": typeof model_meetings;
  "model/messages": typeof model_messages;
  "model/noiseSenders": typeof model_noiseSenders;
  "model/notifications": typeof model_notifications;
  "model/oauthStates": typeof model_oauthStates;
  "model/ops": typeof model_ops;
  "model/people": typeof model_people;
  "model/preferences": typeof model_preferences;
  "model/projects": typeof model_projects;
  "model/reminders": typeof model_reminders;
  "model/saved": typeof model_saved;
  "model/skills": typeof model_skills;
  "model/tasks": typeof model_tasks;
  "model/userContext": typeof model_userContext;
  "model/users": typeof model_users;
  notify: typeof notify;
  ops: typeof ops;
  reminders: typeof reminders;
  saved: typeof saved;
  "security/crypto": typeof security_crypto;
  "security/hash": typeof security_hash;
  "tools/router": typeof tools_router;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
};
