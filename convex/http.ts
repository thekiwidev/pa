import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { checkConfig } from "./lib/config";
import { authorizeUrl } from "./connectors/gmail/oauth";
import { answerCallbackQuery } from "./channels/telegram";
import { verifyGooglePushToken } from "./connectors/google/jwt";
import { parsePushEnvelope } from "./lib/email/pubsub";

const http = httpRouter();

// HTTP actions are served from <deployment>.convex.site — NOT .convex.cloud.
http.route({
  path: "/health",
  method: "GET",
  handler: httpAction(async () => {
    const { ok } = checkConfig();
    // Return configOk ONLY. Never the missing variable names, never the
    // deployment URL, never dependency versions. A leaky health endpoint
    // is a real finding.
    return new Response(JSON.stringify({ status: "ok", configOk: ok }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

/**
 * Telegram updates. Three things matter here and all three are security or
 * reliability, not features:
 *
 * 1. Verify the secret header. Telegram sends X-Telegram-Bot-Api-Secret-Token
 *    on every request when one was set at registration. Anything without it
 *    is not Telegram.
 * 2. Serve exactly one user. Any other sender gets silence and an audit row.
 * 3. Return 200 in milliseconds. Telegram retries on slow or non-2xx
 *    responses, so acknowledge immediately and process in a scheduled
 *    function. This pattern repeats for the Gmail webhook in Phase 8.
 */
http.route({
  path: "/webhooks/telegram",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // 1. Is this actually Telegram?
    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!expected || !secret || secret !== expected) {
      return new Response("unauthorized", { status: 401 });
    }

    let update: unknown;
    try {
      update = await request.json();
    } catch {
      return new Response("bad request", { status: 400 });
    }

    // A button tap on a card sendCard/editCard produced. Checked before
    // parseTextMessage because callback_query and message are mutually
    // exclusive on a Telegram Update -- there is no ambiguity to resolve.
    const callback = parseCallbackQuery(update);
    if (callback) {
      // Acknowledge FIRST. Telegram shows a spinner on the tapped button
      // until this responds, and times it out client-side around 10s --
      // well before a model call inside handleCallback could finish.
      await answerCallbackQuery(callback.id);

      if (callback.fromId !== process.env.TELEGRAM_OWNER_ID) {
        await ctx.runMutation(internal.model.audit.record, {
          actor: "system",
          action: "telegram.reject_unknown_sender",
          args: { fromId: callback.fromId },
          result: "denied",
        });
        return new Response(null, { status: 200 });
      }

      await ctx.scheduler.runAfter(0, internal.assistant.handleCallback, {
        telegramId: callback.fromId,
        chatId: callback.chatId,
        channelMessageId: callback.messageId,
        data: callback.data,
      });
      return new Response(null, { status: 200 });
    }

    const message = parseTextMessage(update);

    // Not text. Before this, a voice note produced total silence — you sent
    // one, nothing came back, and there was no way to tell the difference
    // between "not supported" and "broken". Acknowledge it instead.
    if (!message) {
      // Voice is a real input modality now, so it routes to transcription
      // rather than to an apology. Everything else still gets acknowledged.
      const voice = parseVoiceMessage(update);
      if (voice && voice.fromId === process.env.TELEGRAM_OWNER_ID) {
        await ctx.scheduler.runAfter(0, internal.assistant.handleVoice, {
          telegramId: voice.fromId,
          chatId: voice.chatId,
          displayName: voice.displayName,
          channelMessageId: voice.channelMessageId,
          fileId: voice.fileId,
          mimeType: voice.mimeType,
        });
        return new Response(null, { status: 200 });
      }

      // A .md/.txt document with a "skill: <name>" caption updates a skill.
      // Everything else still falls through to the generic apology below.
      const doc = parseSkillDocument(update);
      if (doc && doc.fromId === process.env.TELEGRAM_OWNER_ID) {
        await ctx.scheduler.runAfter(0, internal.assistant.handleSkillDocument, {
          telegramId: doc.fromId,
          chatId: doc.chatId,
          skillName: doc.skillName,
          fileId: doc.fileId,
          mimeType: doc.mimeType,
        });
        return new Response(null, { status: 200 });
      }

      // A photo, or one slide of an album.
      const photo = parsePhotoMessage(update);
      if (photo && photo.fromId === process.env.TELEGRAM_OWNER_ID) {
        await ctx.scheduler.runAfter(0, internal.assistant.handlePhoto, {
          telegramId: photo.fromId,
          chatId: photo.chatId,
          displayName: photo.displayName,
          channelMessageId: photo.channelMessageId,
          fileId: photo.fileId,
          caption: photo.caption,
          mediaGroupId: photo.mediaGroupId,
        });
        return new Response(null, { status: 200 });
      }

      // A .md/.txt/.pdf the user wants read. Runs after parseSkillDocument,
      // so "skill: name" still means a skill upload.
      const document = parseDocumentMessage(update);
      if (document && document.fromId === process.env.TELEGRAM_OWNER_ID) {
        await ctx.scheduler.runAfter(0, internal.assistant.handleDocument, {
          telegramId: document.fromId,
          chatId: document.chatId,
          displayName: document.displayName,
          channelMessageId: document.channelMessageId,
          fileId: document.fileId,
          fileName: document.fileName,
          mimeType: document.mimeType,
          caption: document.caption,
        });
        return new Response(null, { status: 200 });
      }

      const unsupported = parseUnsupportedMessage(update);
      if (unsupported && unsupported.fromId === process.env.TELEGRAM_OWNER_ID) {
        await ctx.scheduler.runAfter(0, internal.assistant.handleUnsupported, {
          chatId: unsupported.chatId,
          kind: unsupported.kind,
        });
      }
      return new Response(null, { status: 200 });
    }

    // 2. Is this the one person this bot serves?
    if (message.fromId !== process.env.TELEGRAM_OWNER_ID) {
      await ctx.runMutation(internal.model.audit.record, {
        actor: "system",
        action: "telegram.reject_unknown_sender",
        args: { fromId: message.fromId },
        result: "denied",
      });
      return new Response(null, { status: 200 });
    }

    // 3. Acknowledge now, work later.
    await ctx.scheduler.runAfter(0, internal.assistant.handleMessage, {
      telegramId: message.fromId,
      chatId: message.chatId,
      displayName: message.displayName,
      channelMessageId: message.channelMessageId,
      text: message.text,
      replyToChannelMessageId: message.replyToChannelMessageId,
      replyToText: message.replyToText,
    });

    return new Response(null, { status: 200 });
  }),
});

interface ParsedTextMessage {
  fromId: string;
  chatId: string;
  displayName: string;
  channelMessageId: string;
  text: string;
  /** Set when the owner used Telegram's Reply on one of OUR messages. */
  replyToChannelMessageId?: string;
  /** The text of the message replied to, as Telegram echoes it back. */
  replyToText?: string;
}

/**
 * Narrow the untrusted webhook body field by field. `await request.json()` is
 * `unknown`; nothing downstream should have to wonder whether `chat.id` was
 * really a number.
 */
function parseTextMessage(update: unknown): ParsedTextMessage | null {
  if (typeof update !== "object" || update === null) return null;
  const message = (update as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;

  const m = message as {
    message_id?: unknown;
    text?: unknown;
    chat?: unknown;
    from?: unknown;
    reply_to_message?: unknown;
  };

  if (typeof m.text !== "string" || m.text.length === 0) return null;
  if (typeof m.message_id !== "number") return null;

  const chat = m.chat as { id?: unknown } | null;
  const from = m.from as { id?: unknown; first_name?: unknown } | null;
  if (typeof chat?.id !== "number") return null;
  if (typeof from?.id !== "number") return null;

  return {
    fromId: String(from.id),
    chatId: String(chat.id),
    displayName: typeof from.first_name === "string" ? from.first_name : "unknown",
    channelMessageId: String(m.message_id),
    text: m.text,
    ...parseReplyTo(m.reply_to_message),
  };
}

/**
 * Telegram includes the replied-to message inline. Without reading it, "when
 * did this come in?" sent as a Reply to an alert card arrived with no idea
 * which email "this" was — so the planner searched, and pasted the search.
 */
function parseReplyTo(raw: unknown): { replyToChannelMessageId?: string; replyToText?: string } {
  if (typeof raw !== "object" || raw === null) return {};
  const r = raw as { message_id?: unknown; text?: unknown; caption?: unknown };
  if (typeof r.message_id !== "number") return {};
  const text = typeof r.text === "string" ? r.text : typeof r.caption === "string" ? r.caption : undefined;
  return {
    replyToChannelMessageId: String(r.message_id),
    replyToText: text?.slice(0, 2000),
  };
}

/**
 * A document (.md/.txt) whose caption states "skill: <name>" updates that
 * skill's content. Requiring an explicit caption — rather than guessing the
 * target from the filename — means a file sent without one falls through to
 * the ordinary "I can't handle this" path instead of silently updating the
 * wrong skill or guessing wrong.
 */
const SKILL_CAPTION = /skill\s*:\s*([a-z0-9_]+)/i;

function parseSkillDocument(update: unknown): {
  fromId: string;
  chatId: string;
  skillName: string;
  fileId: string;
  mimeType: string;
} | null {
  if (typeof update !== "object" || update === null) return null;
  const message = (update as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;

  const m = message as Record<string, unknown>;
  const chat = m.chat as { id?: unknown } | null;
  const from = m.from as { id?: unknown } | null;
  if (typeof chat?.id !== "number" || typeof from?.id !== "number") return null;

  const doc = m.document as
    | { file_id?: unknown; mime_type?: unknown; file_name?: unknown }
    | undefined;
  if (typeof doc?.file_id !== "string") return null;

  const caption = typeof m.caption === "string" ? m.caption : "";
  const match = SKILL_CAPTION.exec(caption);
  if (!match) return null; // no "skill: name" — not a skill update, fall through

  const mimeType = typeof doc.mime_type === "string" ? doc.mime_type : "";
  const filename = typeof doc.file_name === "string" ? doc.file_name : "";
  const looksTextLike =
    mimeType.startsWith("text/") || filename.endsWith(".md") || filename.endsWith(".txt");
  if (!looksTextLike) return null; // a PDF captioned "skill: x" is not this feature

  return {
    fromId: String(from.id),
    chatId: String(chat.id),
    skillName: match[1]!.toLowerCase(),
    fileId: doc.file_id,
    mimeType: mimeType || "text/plain",
  };
}

/**
 * A photo, or one slide of an album.
 *
 * Telegram sends each `photo` in several sizes, largest last, and sends an
 * ALBUM as SEPARATE updates that share a `media_group_id` — there is no
 * single "album" update to wait for. That id is carried through so the
 * handler can buffer the slides and read them as one document, which is the
 * whole point for a carousel of text slides.
 */
function parsePhotoMessage(update: unknown): {
  fromId: string;
  chatId: string;
  displayName: string;
  channelMessageId: string;
  fileId: string;
  caption: string;
  mediaGroupId?: string;
} | null {
  if (typeof update !== "object" || update === null) return null;
  const message = (update as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;

  const m = message as Record<string, unknown>;
  const chat = m.chat as { id?: unknown } | null;
  const from = m.from as { id?: unknown; first_name?: unknown } | null;
  if (typeof chat?.id !== "number" || typeof from?.id !== "number") return null;
  if (typeof m.message_id !== "number") return null;

  const sizes = m.photo;
  if (!Array.isArray(sizes) || sizes.length === 0) return null;

  // Last entry is the largest. Text on a flyer is unreadable at thumbnail
  // size, and reading text is what these images are for.
  const largest = sizes[sizes.length - 1] as { file_id?: unknown } | undefined;
  if (typeof largest?.file_id !== "string") return null;

  return {
    fromId: String(from.id),
    chatId: String(chat.id),
    displayName: typeof from.first_name === "string" ? from.first_name : "unknown",
    channelMessageId: String(m.message_id),
    fileId: largest.file_id,
    // On an album Telegram puts the caption on ONE slide, usually the first.
    caption: typeof m.caption === "string" ? m.caption : "",
    mediaGroupId: typeof m.media_group_id === "string" ? m.media_group_id : undefined,
  };
}

/**
 * A document the user wants READ — .md, .txt or .pdf.
 *
 * Runs after parseSkillDocument, so a file captioned "skill: name" is still a
 * skill upload and never lands here. Everything else text-like or PDF becomes
 * content to work with.
 */
function parseDocumentMessage(update: unknown): {
  fromId: string;
  chatId: string;
  displayName: string;
  channelMessageId: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  caption: string;
} | null {
  if (typeof update !== "object" || update === null) return null;
  const message = (update as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;

  const m = message as Record<string, unknown>;
  const chat = m.chat as { id?: unknown } | null;
  const from = m.from as { id?: unknown; first_name?: unknown } | null;
  if (typeof chat?.id !== "number" || typeof from?.id !== "number") return null;
  if (typeof m.message_id !== "number") return null;

  const doc = m.document as
    | { file_id?: unknown; mime_type?: unknown; file_name?: unknown }
    | undefined;
  if (typeof doc?.file_id !== "string") return null;

  const mimeType = typeof doc.mime_type === "string" ? doc.mime_type : "";
  const fileName = typeof doc.file_name === "string" ? doc.file_name : "";
  const lower = fileName.toLowerCase();

  // .vtt and .srt are subtitle formats and the usual export from a meeting
  // recorder. lib/meetings/transcript.ts strips their cue numbering.
  const isText =
    mimeType.startsWith("text/") ||
    [".md", ".txt", ".vtt", ".srt"].some((ext) => lower.endsWith(ext));
  const isPdf = mimeType === "application/pdf" || lower.endsWith(".pdf");
  // Deliberately narrow. A .docx or .zip would be silently mangled by the
  // text decoder, and "I read your file" about garbage is worse than "I
  // can't read that yet".
  if (!isText && !isPdf) return null;

  return {
    fromId: String(from.id),
    chatId: String(chat.id),
    displayName: typeof from.first_name === "string" ? from.first_name : "unknown",
    channelMessageId: String(m.message_id),
    fileId: doc.file_id,
    fileName: fileName || (isPdf ? "document.pdf" : "document.txt"),
    mimeType: mimeType || (isPdf ? "application/pdf" : "text/plain"),
    caption: typeof m.caption === "string" ? m.caption : "",
  };
}

interface ParsedCallbackQuery {
  id: string;
  fromId: string;
  chatId: string;
  messageId: string;
  data: string;
}

/**
 * A tap on one of sendCard's inline-keyboard buttons. `callback_query.id` is
 * what answerCallbackQuery needs; `message.message_id` is the CARD's id
 * (what editCard would target), not a new inbound message id.
 */
function parseCallbackQuery(update: unknown): ParsedCallbackQuery | null {
  if (typeof update !== "object" || update === null) return null;
  const cq = (update as { callback_query?: unknown }).callback_query;
  if (typeof cq !== "object" || cq === null) return null;

  const c = cq as Record<string, unknown>;
  const from = c.from as { id?: unknown } | null;
  const message = c.message as { chat?: unknown; message_id?: unknown } | null;
  const chat = (message?.chat ?? null) as { id?: unknown } | null;

  if (typeof c.id !== "string") return null;
  if (typeof from?.id !== "number") return null;
  if (typeof chat?.id !== "number") return null;
  if (typeof message?.message_id !== "number") return null;
  if (typeof c.data !== "string") return null;

  return {
    id: c.id,
    fromId: String(from.id),
    chatId: String(chat.id),
    messageId: String(message.message_id),
    data: c.data,
  };
}

/**
 * Identify a message we cannot process yet, so the bot can say so rather than
 * going quiet. Voice becomes real in Phase 9; the rest may never.
 */
function parseUnsupportedMessage(
  update: unknown,
): { fromId: string; chatId: string; kind: string } | null {
  if (typeof update !== "object" || update === null) return null;
  const message = (update as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;

  const m = message as Record<string, unknown>;
  const chat = m.chat as { id?: unknown } | null;
  const from = m.from as { id?: unknown } | null;
  if (typeof chat?.id !== "number" || typeof from?.id !== "number") return null;

    // voice and audio are handled by parseVoiceMessage before this runs.
  // photo and document are handled above when readable; anything reaching
  // here is a kind with no support at all, or a document type we decline to
  // guess at (.docx, .zip).
  const KINDS = ["photo", "document", "video", "video_note", "sticker"];
  const kind = KINDS.find((k) => m[k] !== undefined);
  if (!kind) return null;

  return { fromId: String(from.id), chatId: String(chat.id), kind };
}

/**
 * A voice note or an audio file, narrowed to what transcription needs.
 *
 * Telegram sends `voice` for a recorded note (Opus in an Ogg container) and
 * `audio` for an uploaded file. Both carry a file_id that must be resolved
 * through getFile before the bytes can be fetched.
 */
function parseVoiceMessage(update: unknown): {
  fromId: string;
  chatId: string;
  displayName: string;
  channelMessageId: string;
  fileId: string;
  mimeType: string;
} | null {
  if (typeof update !== "object" || update === null) return null;
  const message = (update as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) return null;

  const m = message as Record<string, unknown>;
  const chat = m.chat as { id?: unknown } | null;
  const from = m.from as { id?: unknown; first_name?: unknown } | null;
  if (typeof chat?.id !== "number" || typeof from?.id !== "number") return null;
  if (typeof m.message_id !== "number") return null;

  const media = (m.voice ?? m.audio) as
    | { file_id?: unknown; mime_type?: unknown }
    | undefined;
  if (typeof media?.file_id !== "string") return null;

  return {
    fromId: String(from.id),
    chatId: String(chat.id),
    displayName: typeof from.first_name === "string" ? from.first_name : "unknown",
    channelMessageId: String(m.message_id),
    fileId: media.file_id,
    // Telegram voice notes are Opus in Ogg and report audio/ogg.
    mimeType: typeof media.mime_type === "string" ? media.mime_type : "audio/ogg",
  };
}

/**
 * Step 1 of the handshake. Redirects to Google.
 *
 * This endpoint is public — every .convex.site route is — so the nonce IS the
 * authorization. It was minted by /connect in Telegram, is bound to the owner,
 * is single-use, and expires in ten minutes. Without a live one this refuses,
 * so a stranger cannot start an OAuth flow against this deployment and attach
 * their mailbox to the owner's account.
 */
http.route({
  path: "/oauth/google/start",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const nonce = new URL(request.url).searchParams.get("state");
    if (!nonce) return page(400, "Missing state", "That link is malformed.");

    const state = await ctx.runMutation(internal.model.oauthStates.peek, { nonce });
    if (!state) {
      return page(
        410,
        "Link expired",
        "This authorization link has expired or was already used. Send /connect again.",
      );
    }

    return new Response(null, {
      status: 302,
      headers: { Location: authorizeUrl(nonce) },
    });
  }),
});

/**
 * Step 2. Google sends the user back here with a code.
 *
 * The state row is consumed atomically, so a replayed callback finds nothing.
 * The code exchange happens in an action because it fetches — and because the
 * refresh token must be encrypted before any mutation sees it.
 */
http.route({
  path: "/oauth/google/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const params = new URL(request.url).searchParams;

    const denied = params.get("error");
    if (denied) return page(200, "Not connected", `Google said: ${denied}. Nothing was saved.`);

    const code = params.get("code");
    const nonce = params.get("state");
    if (!code || !nonce) return page(400, "Missing parameters", "That callback was incomplete.");

    const state = await ctx.runMutation(internal.model.oauthStates.consume, { nonce });
    if (!state) {
      return page(
        410,
        "Link expired",
        "This authorization link has expired or was already used. Send /connect again.",
      );
    }

    const user = await ctx.runQuery(internal.model.users.get, { userId: state.userId });
    if (!user) return page(500, "Unknown user", "Could not identify who started this.");

    // Do the exchange in the background: Google's callback should not wait on
    // a token round trip plus a first sync, and the result arrives in Telegram.
    await ctx.scheduler.runAfter(0, internal.gmail.completeConnect, {
      code,
      userId: state.userId,
      label: state.label,
      telegramId: user.telegramId,
      // A fresh /connect names the mailbox; a /reconnect only refreshes a
      // credential and must leave the existing label alone. `state.label` is
      // already the account's own label on the reconnect path, so this is
      // belt and braces — see the note on connectedAccounts.upsert.
      relabel: state.reconnectAccountId === undefined,
    });

    return page(
      200,
      "Connected",
      "You can close this tab — the confirmation is in Telegram.",
    );
  }),
});

/** A minimal self-contained page. An httpAction can return any Response, so
 *  the OAuth flow needs no frontend. */
function page(status: number, heading: string, body: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${heading}</title>` +
      `<div style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:20vh auto;padding:0 1.5rem">` +
      `<h1 style="font-size:1.25rem;margin:0 0 .5rem">${heading}</h1>` +
      `<p style="margin:0;color:#555">${body}</p></div>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

/**
 * Gmail push notifications, via Google Cloud Pub/Sub.
 *
 * This endpoint is on `.convex.site` and is therefore PUBLIC. Nothing about
 * the URL is secret and nothing about it can be — so the only thing between
 * a stranger and "make this deployment sync a mailbox" is the OIDC token
 * Google attaches to every push, verified below against Google's own keys.
 *
 * Three rules this handler follows, all of them about not making things
 * worse than a missed notification:
 *
 *  1. It ALWAYS returns 200, even when it refuses. A non-2xx tells Pub/Sub
 *     to redeliver, so an unparseable or unauthorised push returned as an
 *     error becomes an infinite retry loop against this deployment.
 *  2. The envelope says only WHICH mailbox changed. It never carries message
 *     content, and none is read from it — the body is fetched from Gmail
 *     under our own credential, so a forged envelope cannot inject an email.
 *  3. It schedules and returns. Pub/Sub has an acknowledgement deadline, and
 *     a sync plus classification is far too slow to hold it open.
 */
http.route({
  path: "/webhooks/gmail",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const ack = () => new Response(null, { status: 200 });

    const audience = process.env.GOOGLE_PUBSUB_AUDIENCE;
    const serviceAccountEmail = process.env.GOOGLE_PUBSUB_SA_EMAIL;
    if (!audience || !serviceAccountEmail) {
      // Unconfigured is not "allow anyone" — it is "this endpoint is closed".
      console.warn("gmail_push_unconfigured: GOOGLE_PUBSUB_AUDIENCE/SA_EMAIL not set");
      return ack();
    }

    const header = request.headers.get("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) {
      await ctx.runMutation(internal.model.audit.record, {
        actor: "system",
        action: "gmail.push_rejected",
        args: { reason: "no bearer token" },
        result: "denied",
      });
      return ack();
    }

    const verified = await verifyGooglePushToken(token, {
      audience,
      serviceAccountEmail,
      nowMs: Date.now(),
    });
    if (!verified.ok) {
      await ctx.runMutation(internal.model.audit.record, {
        actor: "system",
        action: "gmail.push_rejected",
        args: { reason: verified.reason },
        result: "denied",
      });
      return ack();
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return ack();
    }

    const envelope = parsePushEnvelope(body);
    if (!envelope) return ack();

    const account = await ctx.runQuery(internal.gmail.accountByEmail, {
      accountEmail: envelope.emailAddress,
    });
    // A push for a mailbox this deployment does not know about is not an
    // error — it is a watch that outlived its account. Drop it quietly.
    if (!account) return ack();

    await ctx.scheduler.runAfter(0, internal.gmail.syncFromHistory, {
      accountId: account.accountId,
    });

    return ack();
  }),
});

export default http;
