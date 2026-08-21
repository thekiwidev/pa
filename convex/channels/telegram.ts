const API = "https://api.telegram.org";

/**
 * Everything that knows Telegram's wire format lives here and nowhere else.
 * Plain `fetch` — no bot framework, per §0.5.
 *
 * Phase 1 deliberately does NOT set parse_mode on sendMessage: without it
 * Telegram treats the body as literal text, so a chat reply can never break
 * on stray Markdown. sendCard/editCard below DO set parse_mode, which is
 * why every field that reaches them must already be escaped by
 * lib/telegram/markdown.ts (composeCard in convex/notify.ts is the only
 * caller that does this) -- nothing in this file escapes anything itself.
 */

/** Telegram rejects messages over 4096 UTF-16 code units. */
const MAX_LEN = 4096;

export async function sendMessage(chatId: string, text: string): Promise<string> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set on this deployment");

  const body = text.length > MAX_LEN ? `${text.slice(0, MAX_LEN - 1)}…` : text;

  const res = await fetch(`${API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: body }),
  });

  if (!res.ok) throw new Error(`telegram sendMessage ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as { result?: { message_id?: number } };
  return String(json.result?.message_id ?? "");
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
 * Send a MarkdownV2 card with an inline keyboard. Returns the new message's
 * id, the same way sendMessage does -- notify.ts stores it so a later reply
 * on the same thread can editCard instead of posting a duplicate.
 */
export async function sendCard(
  chatId: string,
  text: string,
  buttons: InlineButton[][],
): Promise<string> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set on this deployment");

  const body = text.length > MAX_LEN ? `${text.slice(0, MAX_LEN - 1)}…` : text;

  const res = await fetch(`${API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: body,
      parse_mode: "MarkdownV2",
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
  text: string,
  buttons: InlineButton[][],
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set on this deployment");

  const body = text.length > MAX_LEN ? `${text.slice(0, MAX_LEN - 1)}…` : text;

  const res = await fetch(`${API}/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: Number(messageId),
      text: body,
      parse_mode: "MarkdownV2",
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
