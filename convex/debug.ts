import { internalAction } from "./_generated/server";
import { v } from "convex/values";
import { runTask } from "./ai/registry";
import { geminiProvider } from "./ai/providers/gemini";
import { seal, open } from "./security/crypto";
import { NotionUnavailable, checkAccess } from "./connectors/notion/client";
import { internalQuery, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { parseToolPlan } from "./lib/tools/plan";
import { planningSystemPrompt, tldrOnlySystemPrompt } from "./lib/prompts/assistant";
import { converse } from "./assistant";
import { resolveProviderChain } from "./lib/ai/resolve";
import { TASKS, modelEnvVar, type TaskName } from "./lib/ai/tiers";
import { backendForAccounts } from "./lib/tasks/backend";
import { listOpenLinearIssues } from "./tools/router";
import { listTeams, listLabels, listWorkflowStates } from "./connectors/linear/client";

/**
 * Operator tools. Internal only — there is no URL for these, so they are
 * unreachable from outside the deployment. Run them with:
 *
 *   bunx convex run debug:pingAI '{}'
 *   bunx convex run debug:pingAI '{"task":"DRAFT_REPLY"}'
 *
 * This exists so provider configuration can be proven from the CLI without
 * sending a Telegram message to verify it.
 */
export const pingAI = internalAction({
  args: {
    task: v.optional(v.string()),
    prompt: v.optional(v.string()),
    /**
     * Bypass the ladder and hit ONE model directly. This is how you answer
     * "is this specific model rate-limited?" — which is the only way to tell
     * whether Gemini's free-tier buckets are per-model or per-project.
     */
    model: v.optional(v.string()),
    /** Inline audio, base64. Proves the TRANSCRIBE path without a real
     *  voice note — see scripts/test-transcription.sh. */
    audioBase64: v.optional(v.string()),
    audioMime: v.optional(v.string()),
    /** Inline image, base64. Proves the VISION path without sending a photo
     *  through Telegram — the same role audioBase64 plays for TRANSCRIBE. */
    imageBase64: v.optional(v.string()),
    imageMime: v.optional(v.string()),
  },
  handler: async (_ctx, args) => {
    const task = (args.task ?? "CHAT_REPLY") as TaskName;

    if (args.model) {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("GEMINI_API_KEY is not set on this deployment");
      const startedAt = Date.now();
      const direct = await geminiProvider.run(
        {
          tier: TASKS[task in TASKS ? task : "CHAT_REPLY"].tier,
          system: "Answer in exactly one short sentence.",
          input: args.prompt ?? "Say that the provider chain is working.",
          maxOutputTokens: 100,
        },
        args.model,
        apiKey,
      );
      return {
        direct: true,
        model: args.model,
        latencyMs: Date.now() - startedAt,
        text: direct.text,
      };
    }

    if (!(task in TASKS)) throw new Error(`Unknown task: ${task}`);

    const { tier } = TASKS[task];
    const chain = resolveProviderChain(process.env, tier, task);

    const startedAt = Date.now();
    const result = await runTask(task, {
      system: args.audioBase64
        ? "You transcribe audio. Output ONLY the verbatim transcript."
        : args.imageBase64
          ? "You read images. Transcribe ALL text you can see, verbatim. Output only the text."
          : "Answer in exactly one short sentence.",
      input: args.audioBase64
        ? "Transcribe the following audio."
        : args.imageBase64
          ? "Read the image."
          : (args.prompt ?? "Say that the provider chain is working."),
      media: args.audioBase64
        ? [{ mimeType: args.audioMime ?? "audio/ogg", dataBase64: args.audioBase64 }]
        : args.imageBase64
          ? [{ mimeType: args.imageMime ?? "image/png", dataBase64: args.imageBase64 }]
          : undefined,
      maxOutputTokens: args.audioBase64 || args.imageBase64 ? 1024 : 100,
    });

    return {
      task,
      tier,
      chain,
      // Which provider actually answered — the fallback may have taken over.
      served_by: result.providerId,
      model: result.model,
      configured_models: Object.fromEntries(
        chain.map((id) => [id, process.env[modelEnvVar(id, tier)] ?? null]),
      ),
      latencyMs: Date.now() - startedAt,
      text: result.text,
    };
  },
});

/**
 * Run the planning pass for a message and return what the model proposed,
 * WITHOUT executing anything.
 *
 * This is the tool for "it said it created a task but /tasks is empty" — it
 * shows the raw model output, the calls that survived validation, and the ones
 * that were rejected and why.
 *
 *   bunx convex run debug:planOnly '{"text":"..."}'
 */
export const planOnly = internalAction({
  args: { text: v.string(), execute: v.optional(v.boolean()) },
  // Explicit return type: without it this handler's inferred type flows
  // through _generated/api and silently degrades ctx.runQuery types in
  // assistant.ts to `any`. See the Convex guidelines on circularity.
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const timezone = process.env.USER_TIMEZONE ?? "Africa/Lagos";
    const telegramId = process.env.TELEGRAM_OWNER_ID;
    if (!telegramId) throw new Error("TELEGRAM_OWNER_ID is not set");

    const user = await ctx.runQuery(internal.model.users.getByTelegramId, { telegramId });
    if (!user) throw new Error("owner has no user row yet — message the bot once first");

    const [projects, localTasks, accounts] = await Promise.all([
      ctx.runQuery(internal.model.projects.listActive, { userId: user._id, limit: 15 }),
      ctx.runQuery(internal.model.tasks.list, { userId: user._id, limit: 15 }),
      ctx.runQuery(internal.model.connectedAccounts.listForUser, { userId: user._id }),
    ]);

    // Mirror converse()'s backend choice, or this tool prints a prompt the
    // assistant never sees — which is the one thing it exists not to do.
    const taskBackend = backendForAccounts(accounts);
    const openTasks =
      taskBackend === "linear"
        ? await listOpenLinearIssues(ctx, user._id)
        : localTasks
            .filter((t) => t.status !== "COMPLETED" && t.status !== "CANCELLED")
            .map((t) => ({ taskId: t._id as string, title: t.title, status: t.status }));

    const system = planningSystemPrompt({
      displayName: user.displayName,
      timezone,
      nowMs: Date.now(),
      projects: projects.map((p) => ({ name: p.name, status: p.status })),
      openTasks,
      taskBackend,
      reminders: [],
      connectedAccounts: accounts.map((a) => ({
        label: a.label,
        email: a.accountEmail,
        status: a.status,
      })),
      customInstructions: (
        await ctx.runQuery(internal.model.instructions.list, { userId: user._id })
      ).map((i) => i.text),
      activeSkills: [],
      userContext: (
        await ctx.runQuery(internal.model.userContext.list, { userId: user._id })
      ).map((c) => ({ category: c.category, text: c.text })),
    });

    // execute:true runs the REAL converse() and nothing else. It must not
    // also run its own planning pass — doing so produced TWO independent
    // plans per invocation, and the args this tool printed were from the
    // throwaway one, not the plan that actually produced the reply.
    if (args.execute === true) {
      // Persist the inbound message BEFORE composing, exactly as
      // assistant.handleMessage does. converse() builds its transcript from
      // the messages table, so skipping this meant the model never saw the
      // message under test — it answered from the last 10 real Telegram
      // turns instead, which made working features look broken.
      await ctx.runMutation(internal.model.messages.record, {
        userId: user._id,
        channel: "debug",
        direction: "in",
        kind: "text",
        text: args.text,
      });

      const reply = await converse(ctx, user._id, user.displayName, args.text);
      return { executed: true, rendered: reply };
    }

    const proposal = await runTask("PLAN_TOOLS", {
      system,
      input: `Conversation so far:\nUser: ${args.text}\n\nRespond to the last user message.`,
      maxOutputTokens: 1500,
    });

    const plan = parseToolPlan(proposal.text);
    return {
      model: proposal.model,
      reply: plan.reply,
      executed_would_be: plan.calls,
      REJECTED: plan.rejected,
    };
  },
});

/**
 * Prove ENCRYPTION_KEY works on THIS deployment before a real refresh token
 * depends on it — a key that decodes to the wrong length, or differs between
 * dev and prod, only shows up as an undecryptable account otherwise.
 *
 *   bunx convex run debug:cryptoSelfTest '{}'
 */
/**
 * One-time: seal LINEAR_API_KEY into a connectedAccounts row.
 *
 * Linear has no OAuth handshake for a personal API key — there is no
 * /connect flow to run instead. This IS the entire "connect Linear" step,
 * and connectedAccounts.upsert is already idempotent on
 * (userId, provider, accountEmail), so running this twice just re-seals the
 * same row rather than duplicating it — safe to re-run after rotating the
 * key.
 *
 *   bunx convex run debug:connectLinear '{}'
 */
export const connectLinear = internalAction({
  args: {},
  handler: async (ctx): Promise<Record<string, unknown>> => {
    const apiKey = process.env.LINEAR_API_KEY;
    if (!apiKey) throw new Error("LINEAR_API_KEY is not set on this deployment");

    const telegramId = process.env.TELEGRAM_OWNER_ID;
    if (!telegramId) throw new Error("TELEGRAM_OWNER_ID is not set");

    const user = await ctx.runQuery(internal.model.users.getByTelegramId, { telegramId });
    if (!user) throw new Error("owner has no user row yet — message the bot once first");

    const sealed = await seal(apiKey);
    const result = await ctx.runMutation(internal.model.connectedAccounts.upsert, {
      userId: user._id,
      provider: "linear",
      // Linear has no mailbox concept — accountEmail is the identity Gmail
      // uses to tell two accounts of the same provider apart. A stable
      // literal does the same job here, since there is only ever one.
      accountEmail: "linear",
      displayName: "Linear",
      label: "linear",
      encryptedCredentials: sealed.ciphertext,
      credentialIv: sealed.iv,
      credentialAuthTag: sealed.authTag,
      scopesGranted: [],
      // Deliberate: "linear" is a fixed literal, not a name the user chose,
      // so re-running this bootstrap should restore it. Gmail's reconnect
      // path is the opposite case and passes relabel:false.
      relabel: true,
    });

    return { accountId: result.accountId, created: result.created };
  },
});

/**
 * Prove the Notion setup works before a note depends on it.
 *
 * The commonest mistake is not the token: it is forgetting to SHARE the notes
 * page with the integration in Notion's UI, which yields a 404 that reads
 * exactly like a wrong id.
 *
 * Reports whether the id resolved to a page or a database, so a silent
 * mismatch between what you configured and what you meant is visible.
 *
 *   bunx convex run debug:checkNotion '{}'
 */
export const checkNotion = internalAction({
  args: {},
  handler: async (): Promise<Record<string, unknown>> => {
    try {
      const result = await checkAccess();
      return { ok: true, kind: result.kind, title: result.title };
    } catch (error) {
      if (error instanceof NotionUnavailable) {
        return {
          ok: false,
          status: error.status,
          hint: error.isAuthFailure
            ? "Token rejected, OR the page is not shared with the integration. In Notion: open the page, ... menu at the top right, Connections, add your integration."
            : error.userFacing,
        };
      }
      return { ok: false, hint: error instanceof Error ? error.message : String(error) };
    }
  },
});

export const cryptoSelfTest = internalAction({
  args: {},
  handler: async (): Promise<Record<string, unknown>> => {
    const secret = `test-refresh-token-${crypto.randomUUID()}`;
    const sealed = await seal(secret);
    const recovered = await open(sealed);

    // The security gate from the build plan: the stored bytes must not
    // contain the plaintext anywhere.
    const stored = new TextDecoder("utf-8", { fatal: false }).decode(sealed.ciphertext);
    const leaks = stored.includes(secret) || stored.includes("test-refresh-token");

    return {
      // Convex injects these; /connect builds its link from CONVEX_SITE_URL.
      convexSiteUrl: process.env.CONVEX_SITE_URL ?? "(NOT SET)",
      roundTrips: recovered === secret,
      plaintextLeakedIntoCiphertext: leaks,
      ciphertextBytes: sealed.ciphertext.byteLength,
      ivBytes: sealed.iv.byteLength,
      authTagBytes: sealed.authTag.byteLength,
    };
  },
});

/** Recent auditLogs, newest first — what actually happened, durably, unlike
 *  `convex logs` which only tails forward from the moment you run it. */
/**
 * What is connected, and therefore where tasks live.
 *
 * Read-only. Exists because the two facts it prints are the ones that break
 * silently: a mailbox LABEL (which a bad /reconnect used to overwrite, so
 * "check my primary mailbox" stopped matching anything) and which store owns
 * tasks (which changes what task.create does).
 *
 *   bunx convex run debug:accounts '{}'
 */
export const accounts = internalAction({
  args: {},
  handler: async (ctx): Promise<Record<string, unknown>> => {
    const telegramId = process.env.TELEGRAM_OWNER_ID;
    if (!telegramId) throw new Error("TELEGRAM_OWNER_ID is not set");

    const user = await ctx.runQuery(internal.model.users.getByTelegramId, { telegramId });
    if (!user) throw new Error("owner has no user row yet — message the bot once first");

    const rows = await ctx.runQuery(internal.model.connectedAccounts.listForUser, {
      userId: user._id,
    });

    // What each Google account can actually DO. Scopes are granted at
    // connect time and Google never adds one to an existing token, so an
    // account connected before a capability shipped has a perfectly valid
    // credential that silently cannot use it. This is the readout that makes
    // that visible instead of surfacing as a 403 mid-conversation.
    const can = (a: (typeof rows)[number], scope: string) =>
      a.provider === "gmail" && a.status === "ACTIVE" && a.scopesGranted.includes(scope);

    const CAPABILITIES = {
      readMail: "https://www.googleapis.com/auth/gmail.readonly",
      sendMail: "https://www.googleapis.com/auth/gmail.send",
      mailboxActions: "https://www.googleapis.com/auth/gmail.modify",
      calendar: "https://www.googleapis.com/auth/calendar.events",
      drive: "https://www.googleapis.com/auth/drive.readonly",
    };

    return {
      accounts: rows.map((a) => ({
        provider: a.provider,
        label: a.label,
        email: a.accountEmail,
        status: a.status,
        ...(a.provider === "gmail"
          ? {
              can: Object.entries(CAPABILITIES)
                .filter(([, scope]) => can(a, scope))
                .map(([name]) => name),
              watchExpiresAt: a.watchExpiresAt
                ? new Date(a.watchExpiresAt).toISOString()
                : "(no push watch)",
            }
          : {}),
      })),
      mailboxLabels: rows
        .filter((a) => a.provider === "gmail" && a.status === "ACTIVE")
        .map((a) => a.label),
      taskBackend: backendForAccounts(rows),
      linearTeamKey: process.env.LINEAR_TEAM_KEY ?? "(unset — uses the only team, or asks)",
      gmailPush: process.env.GOOGLE_PUBSUB_TOPIC
        ? {
            topic: process.env.GOOGLE_PUBSUB_TOPIC,
            audienceSet: Boolean(process.env.GOOGLE_PUBSUB_AUDIENCE),
            serviceAccountSet: Boolean(process.env.GOOGLE_PUBSUB_SA_EMAIL),
          }
        : "(not configured — mail is polled every 10 min instead)",
    };
  },
});

/**
 * Prove the Linear connection and every lookup task.create depends on.
 *
 * Read-only. Mirrors debug:checkNotion — a GraphQL field name that is wrong
 * fails identically to a bad key, and finding that out from a failed
 * task.create in Telegram is the expensive way.
 *
 *   bunx convex run debug:checkLinear '{}'
 */
export const checkLinear = internalAction({
  args: {},
  handler: async (ctx): Promise<Record<string, unknown>> => {
    const telegramId = process.env.TELEGRAM_OWNER_ID;
    if (!telegramId) throw new Error("TELEGRAM_OWNER_ID is not set");

    const user = await ctx.runQuery(internal.model.users.getByTelegramId, { telegramId });
    if (!user) throw new Error("owner has no user row yet — message the bot once first");

    const rows = await ctx.runQuery(internal.model.connectedAccounts.listForUser, {
      userId: user._id,
    });
    const account = rows.find((a) => a.provider === "linear" && a.status === "ACTIVE");
    if (!account) {
      return {
        ok: false,
        hint: "No ACTIVE Linear account. Run `bunx convex run debug:connectLinear '{}'`.",
      };
    }

    const apiKey = await open({
      ciphertext: account.encryptedCredentials,
      iv: account.credentialIv,
      authTag: account.credentialAuthTag,
    });

    const teams = await listTeams(apiKey);
    const labels = await listLabels(apiKey);
    const wanted = process.env.LINEAR_TEAM_KEY;
    const team = wanted
      ? teams.find((t) => t.key.toLowerCase() === wanted.toLowerCase())
      : teams.length === 1
        ? teams[0]
        : undefined;

    const states = team ? await listWorkflowStates(apiKey, team.key) : [];

    return {
      ok: true,
      teams: teams.map((t) => t.key),
      teamForNewIssues: team?.key ?? "(ambiguous — set LINEAR_TEAM_KEY)",
      // The `type` on each is what "move it to done" actually matches against.
      states: states.map((st) => `${st.name} (${st.type})`),
      labels: labels.map((l) => l.name).slice(0, 40),
    };
  },
});

export const recentAudit = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("auditLogs").order("desc").take(args.limit ?? 30);
    return rows.map((r) => ({
      time: new Date(r._creationTime).toISOString(),
      actor: r.actor,
      action: r.action,
      result: r.result,
      error: r.errorMessage,
      args: r.args,
    }));
  },
});

/** Raw oauthStates rows — to see whether a nonce still exists, and its ttl. */
export const oauthStateRows = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("oauthStates").order("desc").take(20);
    return rows.map((r) => ({
      nonce: r.nonce.slice(0, 8) + "…",
      label: r.label,
      expiresAt: new Date(r.expiresAt).toISOString(),
      expired: r.expiresAt < Date.now(),
    }));
  },
});

export const rawInstructions = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("customInstructions").order("desc").take(20);
    return rows.map((r) => ({
      id: r._id,
      userId: r.userId,
      text: r.text,
      created: new Date(r._creationTime).toISOString(),
    }));
  },
});

/**
 * Compose a TL;DR for one email with NO conversation history in play.
 *
 * converse() feeds the last 10 turns to the model, so re-asking a question
 * the user already asked gets "I answered that above" instead of a fresh
 * answer — which makes verifying compose behaviour through planOnly
 * unreliable. This exercises the real prompt and the real model against one
 * email, and nothing else.
 *
 *   bunx convex run debug:tldrFor '{"fragment":"FairMoney clinic"}'
 */
export const tldrFor = internalAction({
  args: { fragment: v.string() },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const telegramId = process.env.TELEGRAM_OWNER_ID;
    if (!telegramId) throw new Error("TELEGRAM_OWNER_ID is not set");
    const user = await ctx.runQuery(internal.model.users.getByTelegramId, { telegramId });
    if (!user) throw new Error("no user row");

    const timezone = process.env.USER_TIMEZONE ?? "Africa/Lagos";
    const accounts = await ctx.runQuery(internal.model.connectedAccounts.listForUser, {
      userId: user._id,
    });
    const accountIds = accounts.filter((a) => a.status === "ACTIVE").map((a) => a._id);

    const message = await ctx.runQuery(internal.model.emailMessages.findByFragment, {
      accountIds,
      fragment: args.fragment,
    });
    if (!message) return { found: false };

    const skill = await ctx.runQuery(internal.model.skills.getEffective, {
      userId: user._id,
      name: "check_email",
    });

    const body = [
      `From: ${message.fromAddress}`,
      `Subject: ${message.subject ?? ""}`,
      `Received: ${new Date(message.receivedAt).toISOString()}`,
      "",
      message.bodyText ?? "",
    ].join("\n");

    const result = await runTask("COMPOSE_REPLY", {
      system: tldrOnlySystemPrompt(skill ? [skill] : [], Date.now(), timezone),
      input: "Write the TL;DR for the email below.",
      untrusted: [{ label: "email", content: body }],
      maxOutputTokens: 600,
    });

    return { found: true, subject: message.subject, tldr: result.text };
  },
});

/**
 * Skills you edited in chat are stored in the database and SHADOW the
 * defaults in lib/skills.ts (MEMORY.md, 2026-08-21). After the 2026-10-15
 * cleanup the defaults changed — so an old edited copy of morning_brief or
 * check_email would keep the old behaviour. This lists which ones are yours.
 *
 *   bunx convex run debug:skillOverrides '{}'
 */
export const skillOverrides = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("skills").take(50);
    return rows.map((r) => ({
      name: r.name,
      title: r.title,
      chars: r.content.length,
      preview: r.content.slice(0, 300),
    }));
  },
});

/**
 * Drop YOUR edited copy of one skill so the new default applies. Prints the
 * old content first so nothing is lost — copy it somewhere if you want it.
 *
 *   bunx convex run debug:resetSkill '{"name":"morning_brief"}'
 */
export const resetSkill = internalMutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("skills").take(50);
    const mine = rows.filter((r) => r.name === args.name);
    for (const row of mine) await ctx.db.delete("skills", row._id);
    return {
      removed: mine.length,
      oldContent: mine.map((r) => r.content),
    };
  },
});
