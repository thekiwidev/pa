import { capCard, type TelegramHtml } from "../lib/telegram/html";
import { markdownToTelegramHtml } from "../lib/telegram/richtext";
import { splitTelegramHtml } from "../lib/telegram/split";

const API = "https://api.telegram.org";

/**
 * Everything that knows Telegram's wire format lives here and nowhere else.
 * Plain `fetch` — no bot framework, per §0.5.
 *
 * ONE formatting system: HTML parse_mode, everywhere, for every send path.
 * Callers pass Markdown; this file converts it. HTML needs three characters
 * escaped where MarkdownV2 needs eighteen, and MarkdownV2 escaping caused two
 * production 400s here before it was retired.
 *
 * Nothing outside this file sets a parse_mode or escapes anything.
 */

export async function sendMessage(chatId: string, text: string): Promise<string> {
  const token = requireToken();

  // Convert FIRST, then split. The reverse order was a live bug: slicing raw
  // markdown at 4096 could cut inside "**", producing unbalanced HTML that
  // Telegram 400s on — and the retry below then re-sent the whole thing with
  // no parse_mode, which is why long messages arrived with every asterisk
  // visible. Conversion also grows the text, so a pre-trimmed body could
  // exceed the limit again afterwards.
  const parts = splitTelegramHtml(markdownToTelegramHtml(text));
  if (parts.length === 0) return "";

  // Plain-text fallbacks are split too, so an over-long message still lands
  // if conversion is what Telegram objected to.
  const plainParts = splitTelegramHtml(text);

  let lastMessageId = "";
  for (let i = 0; i < parts.length; i++) {
    const html = parts[i] ?? "";
    lastMessageId = await sendOne(token, chatId, html, plainParts[i] ?? html);
  }
  return lastMessageId;
}

/**
 * One message, with a single plain-text retry.
 *
 * A conversion bug must never cost the user their reply: delivering
 * unformatted beats delivering nothing. The failure is logged rather than
 * swallowed, because a silent downgrade is how the formatting problem stayed
 * invisible for two days.
 */
async function sendOne(
  token: string,
  chatId: string,
  html: string,
  plain: string,
): Promise<string> {
  let res = await post(token, { chat_id: chatId, text: html, parse_mode: "HTML" });

  if (!res.ok) {
    const detail = await res.text();
    console.warn(`telegram_html_rejected, retrying as plain text: ${detail.slice(0, 200)}`);
    res = await post(token, { chat_id: chatId, text: plain });
    if (!res.ok) {
      throw new Error(`telegram sendMessage ${res.status}: ${await res.text()}`);
    }
  }

  const json = (await res.json()) as { result?: { message_id?: number } };
  return String(json.result?.message_id ?? "");
}

function requireToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set on this deployment");
  return token;
}

function post(token: string, payload: Record<string, unknown>): Promise<Response> {
  return fetch(`${API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/**
 * Download a file the bot was sent, as base64.
 *
 * Two hops: getFile resolves a file_id to a path, then the file is fetched
 * from a DIFFERENT host prefix (/file/bot<token>/...). The token appears in
 * that URL because Telegram offers no header alternative — it is never logged.
 *
 * Bot API caps downloads at 20 MB, which is far above any voice note.
 */
export async function downloadFile(
  fileId: string,
): Promise<{ base64: string; sizeBytes: number }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set on this deployment");

  const meta = await fetch(`${API}/bot${token}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!meta.ok) throw new Error(`telegram getFile ${meta.status}: ${await meta.text()}`);

  const metaJson = (await meta.json()) as {
    result?: { file_path?: string; file_size?: number };
  };
  const filePath = metaJson.result?.file_path;
  if (!filePath) throw new Error("telegram getFile returned no file_path");

  const file = await fetch(`${API}/file/bot${token}/${filePath}`);
  if (!file.ok) throw new Error(`telegram file download ${file.status}`);

  const bytes = new Uint8Array(await file.arrayBuffer());
  return { base64: toBase64(bytes), sizeBytes: bytes.length };
}

export interface InlineButton {
  text: string;
  /** Becomes callback_data. Telegram caps this at 64 bytes total, including
   *  the prefix -- see CALLBACK_PREFIX in convex/notify.ts. */
  data: string;
}

function toInlineKeyboard(buttons: InlineButton[][]) {
  return buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data })));
}

/**
 * Send a card with an inline keyboard. Returns the new message's id, the same
 * way sendMessage does -- notify.ts stores it so a later reply on the same
 * thread can editCard instead of posting a duplicate.
 *
 * Takes `TelegramHtml`, not a bare string: the brand is what makes "forgot to
 * escape" a compile error rather than a runtime 400 (MEMORY.md, 2026-08-21).
 * A card is a single message by definition -- it carries buttons -- so it
 * truncates where sendMessage splits.
 */
export async function sendCard(
  chatId: string,
  text: TelegramHtml,
  buttons: InlineButton[][],
): Promise<string> {
  const token = requireToken();

  const res = await fetch(`${API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: capCard(text),
      parse_mode: "HTML",
      // A card's link is an action, not something to preview: a full
      // YouTube preview under a two-line alert buries the alert.
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: toInlineKeyboard(buttons) },
    }),
  });

  if (!res.ok) throw new Error(`telegram sendMessage(card) ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as { result?: { message_id?: number } };
  return String(json.result?.message_id ?? "");
}

/** Edit an existing card in place. This is what makes three replies on one
 *  thread inside an hour update one message instead of posting three. */
export async function editCard(
  chatId: string,
  messageId: string,
  text: TelegramHtml,
  buttons: InlineButton[][],
): Promise<void> {
  const token = requireToken();

  const res = await fetch(`${API}/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: Number(messageId),
      text: capCard(text),
      parse_mode: "HTML",
      // A card's link is an action, not something to preview: a full
      // YouTube preview under a two-line alert buries the alert.
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: toInlineKeyboard(buttons) },
    }),
  });

  if (!res.ok) throw new Error(`telegram editMessageText ${res.status}: ${await res.text()}`);
}

/**
 * Clears the loading spinner Telegram shows on a tapped inline-keyboard
 * button. Telegram gives a callback_query roughly 10 seconds before the
 * client shows it as failed, so http.ts calls this BEFORE scheduling any
 * real work -- the same "acknowledge now, work later" shape as the message
 * webhook, just with a different acknowledgement call.
 */
export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set on this deployment");

  const res = await fetch(`${API}/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });

  if (!res.ok) {
    throw new Error(`telegram answerCallbackQuery ${res.status}: ${await res.text()}`);
  }
}

/**
 * ArrayBuffer -> base64 in the V8 runtime, which has `btoa` but no Buffer.
 *
 * Chunked because String.fromCharCode(...bytes) blows the argument limit and
 * throws RangeError somewhere north of ~100 KB — exactly the size a voice note
 * reaches, so the naive version fails only in production.
 */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
