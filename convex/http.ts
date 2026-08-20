import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { checkConfig } from "./lib/config";
import { authorizeUrl } from "./connectors/gmail/oauth";

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

// Phase 8 adds: POST /webhooks/gmail

export default http;
