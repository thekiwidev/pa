// Ops: the bot telling its owner when it is broken.
//
// Three layers, outermost first:
//   1. healthchecks.io watches the `heartbeat` cron from OUTSIDE Convex, so a
//      dead deployment still gets reported (by them, not us).
//   2. `checkConnections` proves every integration daily at 06:30 WAT,
//      before the morning check-in needs them.
//   3. `reportIncident` is called from every catch that matters and sends
//      one rate-limited Telegram line per distinct failure.

import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { sendCard, sendMessage } from "./channels/telegram";
import { alreadyHtml, escapeTelegramHtml } from "./lib/telegram/html";
import { classify, fingerprint, formatAlert, formatDigest, scrubSecrets, type Severity } from "./lib/ops/incident";
import { renderHealth, type CheckResult } from "./lib/ops/health";
import { formatInstant } from "./lib/time";
import { linearApiKey } from "./tools/router";
import { listTeams } from "./connectors/linear/client";
import { checkAccess as notionCheckAccess } from "./connectors/notion/client";
import { routeWarnings } from "./lib/ai/routes";

const TZ = () => process.env.USER_TIMEZONE ?? "Africa/Lagos";

/**
 * Record a failure and, when it is new or an hour has passed, tell the owner.
 *
 * NEVER throws. It is called from inside catch blocks, and a reporter that
 * can fail turns one error into two and hides the first.
 */
export async function reportIncident(
  ctx: ActionCtx,
  input: { source: string; error: unknown; severity?: Severity },
): Promise<void> {
  try {
    const message = input.error instanceof Error ? input.error.message : String(input.error);
    const classified = classify(input.source, message);
    const severity = input.severity ?? classified.severity;
    const fp = fingerprint(input.source, message);
    console.error(`incident ${fp} ${input.source}: ${scrubSecrets(message).slice(0, 300)}`);

    const recorded = await ctx.runMutation(internal.model.ops.recordIncident, {
      fingerprint: fp,
      source: input.source,
      severity,
      message,
    });
    if (!recorded.alert) return;

    const ownerChat = process.env.TELEGRAM_OWNER_ID;
    if (!ownerChat) return;
    const text = formatAlert({
      source: input.source,
      message,
      count: recorded.count,
      firstAt: recorded.firstAt,
      firstAtText: formatInstant(recorded.firstAt, TZ()),
      fix: classified.fix,
    });
    await sendCard(ownerChat, alreadyHtml(escapeTelegramHtml(text)), [
      [
        { text: "Mute 24h", data: `opsmute:${fp}` },
        { text: "Health", data: `opshealth:${fp}` },
      ],
    ]);
  } catch (reportError) {
    console.error(`incident_report_failed: ${String(reportError)}`);
  }
}

/** For callers that are not actions (or want it off their own clock). */
export const report = internalAction({
  args: { source: v.string(), message: v.string(), severity: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await reportIncident(ctx, {
      source: args.source,
      error: args.message,
      severity: args.severity as Severity | undefined,
    });
  },
});

async function check(name: string, run: () => Promise<void>, fix?: string): Promise<CheckResult> {
  try {
    await run();
    return { name, ok: true };
  } catch (error) {
    const detail = scrubSecrets(error instanceof Error ? error.message : String(error)).slice(0, 160);
    return { name, ok: false, detail, ...(fix ? { fix } : {}) };
  }
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<void> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${new URL(url).hostname} returned ${res.status}`);
  await res.body?.cancel();
}

/**
 * One real call per integration. Returns the results; when `alert` is set,
 * each failure becomes an incident and each success closes the old ones.
 */
export async function runConnectionChecks(ctx: ActionCtx, alert: boolean): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const ownerId = process.env.TELEGRAM_OWNER_ID;
  const user = ownerId ? await ctx.runQuery(internal.model.users.getByTelegramId, { telegramId: ownerId }) : null;
  const accounts = user ? await ctx.runQuery(internal.model.connectedAccounts.listForUser, { userId: user._id }) : [];

  // Google: every mailbox, by minting a token from its stored refresh token.
  for (const account of accounts.filter((a) => a.provider === "gmail")) {
    const name = `Google · ${account.label}`;
    if (account.status !== "ACTIVE") {
      results.push({ name, ok: false, detail: `marked ${account.status}`, fix: `/reconnect ${account.label}` });
      continue;
    }
    results.push(
      await check(
        name,
        async () => {
          await ctx.runAction(internal.gmail.accessTokenForAccount, { accountId: account._id });
        },
        `/reconnect ${account.label}`,
      ),
    );
  }
  if (!accounts.some((a) => a.provider === "gmail")) {
    results.push({ name: "Google", ok: false, skipped: true });
  }

  // Linear
  if (user && accounts.some((a) => a.provider === "linear")) {
    results.push(
      await check(
        "Linear",
        async () => {
          await listTeams(await linearApiKey(ctx, user._id));
        },
        "new key → bunx convex env set LINEAR_API_KEY … → bunx convex run debug:connectLinear",
      ),
    );
  } else {
    results.push({ name: "Linear", ok: false, skipped: true });
  }

  // Notion
  if (process.env.NOTION_API_KEY) {
    results.push(
      await check("Notion", async () => {
        await notionCheckAccess();
      }, "share the notes page/database with your integration"),
    );
  } else {
    results.push({ name: "Notion", ok: false, skipped: true });
  }

  // AI providers: a model list costs no tokens.
  const openaiKey = process.env.OPENAI_API_KEY;
  results.push(
    openaiKey
      ? await check("OpenAI", () => getJson("https://api.openai.com/v1/models", { Authorization: `Bearer ${openaiKey}` }), "check OPENAI_API_KEY and billing")
      : { name: "OpenAI", ok: false, skipped: true },
  );
  const geminiKey = process.env.GEMINI_API_KEY;
  results.push(
    geminiKey
      ? await check("Gemini", () => getJson("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { "x-goog-api-key": geminiKey }), "check GEMINI_API_KEY")
      : { name: "Gemini", ok: false, skipped: true },
  );

  // Model ladders: a retired id or a floating alias that can land on a paid model.
  const modelWarnings = routeWarnings(process.env);
  results.push(
    modelWarnings.length === 0
      ? { name: "AI model ladders", ok: true }
      : { name: "AI model ladders", ok: false, detail: modelWarnings.join("; "), fix: "bunx convex run debug:aiRoutes '{}' and reset those variables" },
  );

  // Apify (saved posts from Instagram)
  const apifyToken = process.env.APIFY_TOKEN;
  results.push(
    apifyToken
      ? await check("Apify", () => getJson("https://api.apify.com/v2/users/me", { Authorization: `Bearer ${apifyToken}` }), "check APIFY_TOKEN")
      : { name: "Apify (Instagram slides)", ok: false, skipped: true },
  );

  // Microsoft client secret expiry, warned 30 days ahead.
  const msExpiry = process.env.MS_CLIENT_SECRET_EXPIRES_AT;
  if (msExpiry) {
    const days = Math.floor((Date.parse(msExpiry) - Date.now()) / 86_400_000);
    results.push(
      Number.isFinite(days) && days > 30
        ? { name: "Microsoft client secret", ok: true }
        : {
            name: "Microsoft client secret",
            ok: false,
            detail: Number.isFinite(days) ? `expires in ${days} days` : "MS_CLIENT_SECRET_EXPIRES_AT is not a date",
            fix: "make a new secret in Entra and set MS_CLIENT_SECRET",
          },
    );
  }

  if (alert) {
    for (const r of results) {
      if (r.skipped) continue;
      const source = `health:${r.name}`;
      if (r.ok) await ctx.runMutation(internal.model.ops.resolveSource, { source });
      else await reportIncident(ctx, { source, error: `${r.detail ?? "failing"}${r.fix ? ` — fix: ${r.fix}` : ""}`, severity: "critical" });
    }
  }
  return results;
}

/** Cron, 06:30 WAT. */
export const checkConnections = internalAction({
  args: {},
  handler: async (ctx) => {
    const results = await runConnectionChecks(ctx, true);
    return results;
  },
});

/** The /health text. */
export async function healthText(ctx: ActionCtx): Promise<string> {
  const checks = await runConnectionChecks(ctx, false);
  const rows = await ctx.runQuery(internal.model.ops.recent, {
    sinceMs: Date.now() - 3 * 24 * 60 * 60 * 1000,
    limit: 20,
  });
  return renderHealth(
    checks,
    rows.map((r) => ({
      source: r.source,
      sample: r.sample,
      count: r.count,
      lastAtText: formatInstant(r.lastAt, TZ()),
      resolved: r.resolvedAt !== undefined,
    })),
  );
}

/**
 * Cron, every 10 minutes. Pings healthchecks.io (or any URL in
 * HEALTHCHECK_PING_URL). If these pings stop, THEY tell you — which is the
 * only way to hear about a deployment that is down entirely.
 */
export const heartbeat = internalAction({
  args: {},
  handler: async () => {
    const url = process.env.HEALTHCHECK_PING_URL;
    if (!url) return { pinged: false };
    try {
      await fetch(url, { method: "GET", signal: AbortSignal.timeout(10_000) });
      return { pinged: true };
    } catch (error) {
      console.warn(`heartbeat_failed: ${String(error)}`);
      return { pinged: false };
    }
  },
});

/** Cron, 19:00 WAT: warnings that kept repeating today, in one message. */
export const digest = internalAction({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.runQuery(internal.model.ops.recent, {
      sinceMs: Date.now() - 24 * 60 * 60 * 1000,
      limit: 50,
    });
    const warns = rows.filter((r) => r.severity === "warn" && r.countSinceDigest > 0);
    const text = formatDigest(warns.map((r) => ({ source: r.source, message: r.sample, count: r.countSinceDigest })));
    const ownerChat = process.env.TELEGRAM_OWNER_ID;
    if (text && ownerChat) await sendMessage(ownerChat, text);
    await ctx.runMutation(internal.model.ops.resetDigestCounts, { ids: warns.map((r) => r._id) });
  },
});
