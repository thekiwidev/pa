// Pure. Turning a failure somewhere in the bot into ONE short Telegram line
// the owner can act on, without the same error arriving fifty times.
//
// The analogy is a smoke alarm with a hush button: it goes off once, says
// which room, and stays quiet about the same smoke for an hour unless you
// ask it to keep shouting.

export type Severity = "critical" | "warn";

export interface IncidentInput {
  /** Where it happened, e.g. "gmail.sync:recruiting", "assistant.message". */
  source: string;
  message: string;
  severity?: Severity;
}

/** Re-alert about the same fingerprint at most once per hour. */
export const REALERT_MS = 60 * 60 * 1000;

/**
 * Anything key-shaped is replaced before text leaves the server. An error
 * message from a provider can echo the request, and the request carries the
 * key.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g, // OpenAI
  /\blin_api_[A-Za-z0-9]{8,}/g, // Linear
  /\bya29\.[A-Za-z0-9._-]{8,}/g, // Google access token
  /\b1\/\/[A-Za-z0-9._-]{20,}/g, // Google refresh token
  /\bAIza[A-Za-z0-9_-]{20,}/g, // Google API key
  /\b(?:secret|ntn)_[A-Za-z0-9]{20,}/g, // Notion
  /\bapify_api_[A-Za-z0-9]{8,}/g, // Apify
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}/g, // Telegram bot token
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /([?&](?:key|token|access_token|api_key)=)[^&\s]+/gi,
];

export function scrubSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: string) =>
      typeof prefix === "string" && match.startsWith(prefix) ? `${prefix}[redacted]` : "[redacted]",
    );
  }
  return out;
}

/**
 * The same failure, whatever its ids, numbers and timestamps. "Gmail 500 on
 * message 18f3a…" and "Gmail 500 on message 19b2c…" are one incident.
 */
export function normalizeMessage(message: string): string {
  return scrubSecrets(message)
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/g, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** FNV-1a, 32-bit, as 8 hex chars. Short enough for a Telegram button. */
export function fingerprint(source: string, message: string): string {
  const text = `${source}|${normalizeMessage(message)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export interface IncidentState {
  lastAlertAt?: number;
  mutedUntil?: number;
}

/**
 * Should this occurrence send a Telegram message right now?
 *
 * Warn-level incidents never page: they wait for the evening digest, and
 * only make it there when they repeated.
 */
export function shouldAlert(state: IncidentState | null, severity: Severity, now: number): boolean {
  if (severity !== "critical") return false;
  if (state?.mutedUntil !== undefined && state.mutedUntil > now) return false;
  if (state?.lastAlertAt !== undefined && now - state.lastAlertAt < REALERT_MS) return false;
  return true;
}

export interface Classified {
  severity: Severity;
  /** One sentence of what to do about it, when there is a known fix. */
  fix?: string;
}

/**
 * Severity and a fix, from what the error says. Auth failures are critical
 * because they never heal on their own; a single 5xx is a warning because
 * it usually does.
 */
export function classify(source: string, message: string): Classified {
  const m = message.toLowerCase();
  const label = source.includes(":") ? source.slice(source.indexOf(":") + 1) : "";

  if (m.includes("invalid_grant") || m.includes("needs_reauth")) {
    return {
      severity: "critical",
      fix: label ? `/reconnect ${label}` : "/reconnect the mailbox in /accounts",
    };
  }
  if (source.startsWith("linear") && /\b401\b|authentication|unauthor/.test(m)) {
    return {
      severity: "critical",
      fix: "make a new Linear key, then bunx convex env set LINEAR_API_KEY … and bunx convex run debug:connectLinear",
    };
  }
  if (source.startsWith("notion") && /\b401\b|unauthorized|restricted|object_not_found/.test(m)) {
    return { severity: "critical", fix: "share the Notion database with your integration (••• → Connections)" };
  }
  if (/quota|rate.?limit|\b429\b|insufficient_quota|billing/.test(m)) {
    return { severity: "warn", fix: "AI quota ran out; it resets on its own, or add credit" };
  }
  if (/all providers failed|no ai provider/.test(m)) {
    return { severity: "critical", fix: "check OPENAI_API_KEY / GEMINI_API_KEY with debug:pingAI" };
  }
  if (source.startsWith("assistant") || source.startsWith("webhook")) {
    return { severity: "critical" };
  }
  if (/\b5\d\d\b|timeout|timed out|econnreset|fetch failed/.test(m)) {
    return { severity: "warn" };
  }
  return { severity: "critical" };
}

const WHERE: Record<string, string> = {
  "assistant.message": "Your last message",
  "assistant.callback": "A button tap",
  "assistant.photo": "Reading an image",
  "assistant.voice": "A voice note",
  "assistant.document": "Reading a document",
  "gmail.sync": "Mail sync",
  "gmail.watch": "Gmail push renewal",
  "brief.deliver": "The morning check-in",
  "reminders.nudge": "Meeting nudges",
  "reminders.fire": "A reminder",
  "linear": "Linear",
  "notion": "Notion",
  "ai": "The AI providers",
  "health": "Connection check",
  "social.ingest": "Saving a post",
  "saved.nudge": "Saved-item reminders",
};

function describeSource(source: string): string {
  const [base, label] = source.split(":");
  const key = Object.keys(WHERE).find((k) => base === k || base?.startsWith(`${k}.`)) ?? base ?? source;
  const where = WHERE[key] ?? source;
  return label ? `${where} (${label})` : where;
}

/** The Telegram line. Plain text, no markup: it goes through sendCard as HTML-escaped. */
export function formatAlert(args: {
  source: string;
  message: string;
  count: number;
  firstAt: number;
  firstAtText: string;
  fix?: string;
}): string {
  const detail = scrubSecrets(args.message).replace(/\s+/g, " ").trim().slice(0, 220);
  const lines = [`🔴 ${describeSource(args.source)} failed: ${detail}`];
  if (args.fix) lines.push(`Fix: ${args.fix}`);
  if (args.count > 1) lines.push(`${args.count}× since ${args.firstAtText}.`);
  return lines.join("\n");
}

/** The evening digest of warnings that repeated today. */
export function formatDigest(rows: { source: string; message: string; count: number }[]): string | null {
  const repeated = rows.filter((r) => r.count >= 3);
  if (repeated.length === 0) return null;
  return [
    `🟠 ${repeated.length} thing${repeated.length === 1 ? "" : "s"} kept failing today:`,
    ...repeated
      .slice(0, 8)
      .map((r) => `• ${describeSource(r.source)}: ${scrubSecrets(r.message).slice(0, 120)} (${r.count}×)`),
  ].join("\n");
}
