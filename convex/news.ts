// The news agent (Phase 25). Orchestration only: the parsing, ranking and
// rendering are pure and live in lib/news/*.
//
//   collect  fetch every enabled source in parallel, normalise, dedupe, pool
//   rank     interests + popularity + recency, no model; embeddings refine it
//   read     the top stories' text through the reader proxy
//   write    one WRITE_NEWSLETTER call, article text in `untrusted` only
//
// Nothing here pushes: the newsletter goes out because the owner asked for it
// (chat) or because a digest they configured includes the "news" section.

import { internalAction } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { runTask } from "./ai/registry";
import { embedTexts } from "./ai/embed";
import { sendCard, sendMessage } from "./channels/telegram";
import { reportIncident } from "./ops";
import { fetchSource } from "./connectors/news/client";
import { fetchViaJina } from "./connectors/social/client";
import { CALLBACK_PREFIX } from "./notify";
import { dedupeCandidates, urlHash, type NewsCandidate } from "./lib/news/normalize";
import { rankCandidates, type Interest } from "./lib/news/rank";
import { baselineInterests, launchQueries } from "./lib/news/baseline";
import { tavilySearch } from "./connectors/web/tavily";
import {
  SOURCE_KINDS,
  senderMatches,
  sourceConfigured,
  sourceName,
  type SourceKind,
  type SourceSpec,
} from "./lib/news/sources";
import {
  WRITE_NEWSLETTER_SYSTEM,
  feedbackButtons,
  headlineOnly,
  parseNewsletter,
  renderNewsletter,
  type NewsletterItem,
} from "./lib/news/newsletter";

const DAY_MS = 24 * 60 * 60 * 1000;
export const POOL_DAYS = 7;
const CARD_ITEMS = 5;
const BODY_CHARS = 2500;
const PRE_RANK = 60;
const FETCH_CONCURRENCY = 6;
const READ_CONCURRENCY = 5;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const toInterest = (i: Doc<"interests">): Interest => ({
  topic: i.topic,
  embedding: i.embedding,
  weight: i.weight,
  expiresAt: i.expiresAt,
  origin: i.origin === "inferred" ? "inferred" : "explicit",
  createdAt: i.createdAt,
});

/** One issue of a newsletter in the owner's mail becomes one story; the text is what was stored. */
async function newsletterItems(ctx: ActionCtx, userId: Id<"users">, spec: SourceSpec, nowMs: number): Promise<NewsCandidate[]> {
  const sender = spec.config.sender;
  if (!sender) return [];
  const accounts = await ctx.runQuery(internal.model.connectedAccounts.listForUser, { userId });
  const accountIds = accounts.filter((a) => a.status === "ACTIVE").map((a) => a._id);
  if (accountIds.length === 0) return [];
  const mail = await ctx.runQuery(internal.model.emailMessages.recentAcross, {
    accountIds,
    sinceMs: nowMs - 3 * DAY_MS,
    limit: 60,
  });
  return mail
    .filter((m) => senderMatches(sender, m.fromAddress))
    .map((m) => ({
      title: m.subject ?? "(no subject)",
      // The query makes each thread a distinct story; Gmail ignores it and opens the thread from the fragment.
      url: `https://mail.google.com/mail/u/0/?th=${m.threadId}#all/${m.threadId}`,
      source: sourceName(spec),
      score: 0,
      publishedAt: m.receivedAt,
      snippet: m.text.replace(/\s+/g, " ").slice(0, 400),
    }));
}

const LAUNCH_RESULTS_EACH = 8;

async function launchWatch(ctx: ActionCtx, userId: Id<"users">, nowMs: number): Promise<{ items: NewsCandidate[]; failed: boolean }> {
  const rows = await ctx.runQuery(internal.model.interests.active, { userId, nowMs });
  const queries = launchQueries(rows.map(toInterest), nowMs);
  let failed = false;
  const batches = await mapLimit(queries, 3, async (query) => {
    try {
      const found = await tavilySearch(query, { news: true, days: 3, max: LAUNCH_RESULTS_EACH });
      // Tavily returns best-first: a falling score keeps that order inside this source.
      return found.map((r, i): NewsCandidate => ({
        title: r.title,
        url: r.url,
        source: "Web news",
        score: LAUNCH_RESULTS_EACH - i,
        publishedAt: r.publishedAt ?? nowMs,
        snippet: r.snippet,
      }));
    } catch (error) {
      failed = true;
      await reportIncident(ctx, { source: "news.tavily", error, severity: "warn" });
      return [] as NewsCandidate[];
    }
  });
  return { items: batches.flat(), failed };
}

export interface CollectResult {
  /** Sources that were tried, with how many stories each gave. */
  sources: { name: string; count: number; failed: boolean }[];
  added: number;
}

/**
 * Fetch every enabled, configured source in parallel (10 s each) and pool the
 * new stories. A failing source is logged as a warning and skipped, never paged.
 */
export async function collectNews(ctx: ActionCtx, userId: Id<"users">, topic?: string): Promise<CollectResult> {
  await ctx.runMutation(internal.model.news.seedDefaults, { userId });
  const rows = await ctx.runQuery(internal.model.news.sources, { userId });
  const specs: SourceSpec[] = rows
    .filter((r) => r.enabled && (SOURCE_KINDS as readonly string[]).includes(r.kind))
    .map((r) => ({ kind: r.kind as SourceKind, config: r.config }))
    .filter((s) => sourceConfigured(s.kind, process.env));

  const now = Date.now();
  const results = await mapLimit(specs, FETCH_CONCURRENCY, async (spec) => {
    const name = sourceName(spec);
    try {
      const items = spec.kind === "newsletter" ? await newsletterItems(ctx, userId, spec, now) : await fetchSource(spec, topic);
      return { name, items, failed: false };
    } catch (error) {
      await reportIncident(ctx, { source: `news.${spec.kind}`, error, severity: "warn" });
      return { name, items: [] as NewsCandidate[], failed: true };
    }
  });

  // The launch watch: news searches for model launches, product announcements
  // and offers, plus the owner's own topics. Skipped without a Tavily key.
  const watched = process.env.TAVILY_API_KEY ? await launchWatch(ctx, userId, now) : { items: [] as NewsCandidate[], failed: false };
  if (watched.items.length > 0 || watched.failed) {
    results.push({ name: "Web news", items: watched.items, failed: watched.failed });
  }

  const sent = new Set(await ctx.runQuery(internal.model.news.sentHashes, { userId, sinceMs: now - POOL_DAYS * DAY_MS }));
  const fresh = dedupeCandidates(results.flatMap((r) => r.items), sent).map((c) => ({
    urlHash: urlHash(c.url),
    url: c.url,
    title: c.title.slice(0, 300),
    source: c.source,
    publishedAt: c.publishedAt,
    score: c.score,
    snippet: c.snippet.slice(0, 400),
  }));
  let added = 0;
  for (let i = 0; i < fresh.length; i += 100) {
    added += await ctx.runMutation(internal.model.news.upsertMany, { userId, items: fresh.slice(i, i + 100), nowMs: now });
  }
  return { sources: results.map((r) => ({ name: r.name, count: r.items.length, failed: r.failed })), added };
}

/** Rank the pool, refining with embeddings when a provider is available. */
async function pickStories(
  ctx: ActionCtx,
  userId: Id<"users">,
  pool: Doc<"newsItems">[],
  count: number,
  topic?: string,
): Promise<Doc<"newsItems">[]> {
  const now = Date.now();
  const byHash = new Map(pool.map((r) => [r.urlHash, r]));
  const candidates: NewsCandidate[] = pool.map((r) => ({
    title: r.title, url: r.url, source: r.source, score: r.score, publishedAt: r.publishedAt, snippet: r.snippet,
  }));
  const interestRows = await ctx.runQuery(internal.model.interests.active, { userId, nowMs: now });
  // The owner's own interests, then the standing baseline (launches and offers).
  // Baseline topics are embedded every run: they are not stored rows.
  const baseline = baselineInterests(now);
  const interests = [...interestRows.map(toInterest), ...baseline];
  const asked: Interest[] = topic
    ? [{ topic, weight: 3, origin: "explicit", createdAt: now }]
    : [];

  const pre = rankCandidates(candidates, [...interests, ...asked], now, { limit: PRE_RANK });

  // Embeddings only when something can use them: interests or a topic to compare against.
  const unembedded = interestRows.filter((i) => !i.embedding).slice(0, 30);
  const texts = [
    ...pre.map((c) => c.title),
    ...unembedded.map((i) => i.topic),
    ...baseline.map((b) => b.topic),
    ...(topic ? [topic] : []),
  ];
  let ranked = pre;
  if (interests.length + asked.length > 0) {
    const vectors = await embedTexts(texts, "document");
    if (vectors) {
      pre.forEach((c, i) => { c.embedding = vectors[i]; });
      // Awaited: an action's un-awaited writes can be cut off when it returns.
      await Promise.all(
        unembedded.map(async (row, i) => {
          const vec = vectors[pre.length + i];
          if (!vec) return;
          const live = interests.find((x) => x.topic === row.topic && x.origin === (row.origin === "inferred" ? "inferred" : "explicit"));
          if (live) live.embedding = vec;
          await ctx.runMutation(internal.model.interests.setEmbedding, { id: row._id, embedding: vec });
        }),
      );
      baseline.forEach((b, i) => { b.embedding = vectors[pre.length + unembedded.length + i]; });
      const topicVec = topic ? vectors[texts.length - 1] : undefined;
      const askedWithVec = asked.map((a) => ({ ...a, embedding: topicVec }));
      ranked = rankCandidates(pre, [...interests, ...askedWithVec], now, { limit: count });
    }
  }
  if (ranked === pre) ranked = rankCandidates(pre, [...interests, ...asked], now, { limit: count });

  return ranked.map((c) => byHash.get(urlHash(c.url))).filter((r): r is Doc<"newsItems"> => Boolean(r));
}

async function readBodies(stories: Doc<"newsItems">[]): Promise<(string | undefined)[]> {
  return await mapLimit(stories, READ_CONCURRENCY, async (s) => {
    if (new URL(s.url).hostname === "mail.google.com") return s.snippet || undefined;
    const page = await fetchViaJina(s.url);
    return page?.caption?.slice(0, BODY_CHARS);
  });
}

export interface NewsletterResult {
  count: number;
  sourceCount: number;
  /** Titles, for the conversation history. */
  titles: string[];
}

export interface NewsletterOptions {
  topic?: string;
  count?: number;
  heading?: string;
}

/**
 * Collect, rank, read, write, send. The reply to "catch me up on tech" and the
 * "news" section of a digest are this same function.
 */
export async function sendNewsletter(ctx: ActionCtx, userId: Id<"users">, options: NewsletterOptions = {}): Promise<NewsletterResult> {
  const user = await ctx.runQuery(internal.model.users.get, { userId });
  if (!user) return { count: 0, sourceCount: 0, titles: [] };
  const count = Math.min(Math.max(options.count ?? 5, 1), 10);

  const collected = await collectNews(ctx, userId, options.topic);
  const sourceCount = collected.sources.filter((s) => s.count > 0).length;
  const pool = await ctx.runQuery(internal.model.news.pool, { userId, sinceMs: Date.now() - POOL_DAYS * DAY_MS });
  const stories = await pickStories(ctx, userId, pool, count, options.topic);
  // Nothing is not a message: a digest stays quiet, the caller answers a direct ask.
  if (stories.length === 0) return { count: 0, sourceCount, titles: [] };

  const bodies = await readBodies(stories);
  const allowed = stories.map((s) => ({ url: s.url, title: s.title, source: s.source }));
  let items: NewsletterItem[];
  try {
    const interestRows = await ctx.runQuery(internal.model.interests.active, { userId, nowMs: Date.now() });
    // Only topics the owner typed go in `input`. Learned ones come from story and
    // page titles (external text), so they travel in `untrusted` like the stories.
    const typed = interestRows.filter((i) => i.weight > 0 && i.origin !== "inferred").map((i) => i.topic).slice(0, 12);
    const learned = interestRows.filter((i) => i.weight > 0 && i.origin === "inferred").map((i) => i.topic).slice(0, 12);
    const result = await runTask("WRITE_NEWSLETTER", {
      system: WRITE_NEWSLETTER_SYSTEM,
      input:
        `Write the newsletter for these ${stories.length} stories, in the order given.` +
        (typed.length > 0 ? ` The reader's current interests: ${typed.join(", ")}.` : "") +
        (options.topic ? ` They asked specifically about: ${options.topic}.` : ""),
      untrusted: [
        ...stories.map((s, i) => ({
          label: `story ${i + 1}`,
          content: [`url: ${s.url}`, `source: ${s.source}`, `title: ${s.title}`, bodies[i] ? `text:\n${bodies[i]}` : `snippet: ${s.snippet}`].join("\n"),
        })),
        ...(learned.length > 0 ? [{ label: "learned interests", content: learned.join("\n") }] : []),
      ],
      maxOutputTokens: 2200,
      json: true,
    });
    items = parseNewsletter(result.text, allowed);
  } catch (error) {
    await reportIncident(ctx, { source: "news.write", error, severity: "warn" });
    items = [];
  }
  if (items.length === 0) items = headlineOnly(allowed);

  const rowsByUrl = new Map(stories.map((s) => [s.url, s]));
  const heading = options.heading ?? (options.topic ? `📰 ${options.topic}` : "📰 Your tech briefing");
  let firstId = "";
  for (let i = 0; i < items.length; i += CARD_ITEMS) {
    const chunk = items.slice(i, i + CARD_ITEMS);
    const ids = chunk.map((it) => rowsByUrl.get(it.url)?._id).filter((id): id is Id<"newsItems"> => Boolean(id));
    const messageId = await sendCard(
      user.telegramId,
      renderNewsletter(chunk, i === 0 ? heading : "…more"),
      feedbackButtons(ids, { up: CALLBACK_PREFIX.NEWS_UP, down: CALLBACK_PREFIX.NEWS_DOWN }),
    );
    firstId ||= messageId;
  }

  await ctx.runMutation(internal.model.news.markSent, {
    ids: stories.map((s) => s._id),
    nowMs: Date.now(),
  });
  await ctx.runMutation(internal.model.messages.record, {
    userId,
    channel: "telegram",
    direction: "out",
    channelMessageId: firstId,
    kind: "text",
    text: `${heading}\n${items.map((it, n) => `${n + 1}. ${it.title} (${it.url})`).join("\n")}`,
  });
  return { count: items.length, sourceCount, titles: items.map((i) => i.title) };
}

/** The 👍 / 👎 under a newsletter item: record it and teach the ranking. */
export async function handleNewsFeedback(
  ctx: ActionCtx,
  userId: Id<"users">,
  chatId: string,
  newsItemId: string,
  verdict: "up" | "down",
): Promise<void> {
  const now = Date.now();
  const row = await ctx.runMutation(internal.model.news.recordFeedback, {
    userId,
    newsItemId: newsItemId as Id<"newsItems">,
    verdict,
    nowMs: now,
  });
  if (!row) {
    await sendMessage(chatId, "That story has aged out, so I can't learn from it. Tell me the topic in words instead.");
    return;
  }
  const vectors = await embedTexts([row.title], "document");
  await ctx.runMutation(internal.model.interests.add, {
    userId,
    topic: row.title.slice(0, 120),
    weight: verdict === "up" ? 0.6 : -0.6,
    origin: "inferred",
    nowMs: now,
    ...(vectors?.[0] ? { embedding: vectors[0] } : {}),
  });
  await sendMessage(chatId, verdict === "up" ? "Noted: more like that." : "Noted: less like that.");
}

/** The tool's entry point (news.brief) and the /news command. */
export const brief = internalAction({
  args: { userId: v.id("users"), topic: v.optional(v.string()), count: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const result = await sendNewsletter(ctx, args.userId, { topic: args.topic, count: args.count });
    return { count: result.count, sources: result.sourceCount, titles: result.titles };
  },
});

/** Daily: stories older than a week go, and so do lapsed interests. */
export const cleanup = internalAction({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - POOL_DAYS * DAY_MS;
    for (let i = 0; i < 25; i++) {
      const removed = await ctx.runMutation(internal.model.news.purgeOld, { olderThanMs: cutoff });
      if (removed < 200) break;
    }
    const ownerId = process.env.TELEGRAM_OWNER_ID;
    if (!ownerId) return;
    const user = await ctx.runQuery(internal.model.users.getByTelegramId, { telegramId: ownerId });
    if (user) await ctx.runMutation(internal.model.interests.purgeExpired, { userId: user._id, nowMs: Date.now() });
  },
});
