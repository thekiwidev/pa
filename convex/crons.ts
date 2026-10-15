import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// CRON EXPRESSIONS ARE UTC. Lagos is UTC+1 with no DST, so subtract one
// hour from every local time. 07:00 WAT is "0 6 * * *".
// Write the offset in a comment above every line or you WILL misread it.
const crons = cronJobs();

// Phase 2 — hygiene. Reminders fire from ctx.scheduler.runAt, not from a
// poll; this sweep only catches deliveries our own bugs could have dropped.
crons.interval("reconcile missed reminders", { hours: 1 }, internal.reminders.reconcile, {});

// Phase 3 — mailbox sync. UTC: Lagos is UTC+1, so 05-22 WAT is 04-21 UTC.
crons.cron("mailbox sync waking", "*/10 4-21 * * *", internal.gmail.syncAll, {});
crons.cron("mailbox sync overnight", "*/30 22,23,0-3 * * *", internal.gmail.syncAll, {});
// Phase 8 adds: daily Gmail watch renewal
// Phase 05B — morning brief safety net. The brief itself is self-scheduling
// (convex/briefs.ts's deliver() reschedules itself +24h after every send,
// same as a reminder's runAt chain never involves this file); this only
// fires if that chain broke. 08:00 WAT is 07:00 UTC — comfortably after the
// earliest sane brief time, so it never races a same-day first-time enable.
crons.cron("ensure brief scheduled", "0 7 * * *", internal.briefs.ensureScheduled, {});

/**
 * Renew every mailbox's Gmail push watch, daily.
 *
 * A watch expires after at most SEVEN DAYS and Google recommends renewing
 * daily. The failure mode is what makes this a cron rather than a setup
 * step: a lapsed watch does not error, it just stops delivering — the
 * assistant would go quiet and look like it was working. No-ops when
 * GOOGLE_PUBSUB_TOPIC is unset, so this is harmless before Pub/Sub exists.
 */
crons.cron("renew gmail watches", "0 5 * * *", internal.gmail.watchAll, {});
/**
 * Meeting nudges — "standup in 30 min". Every 5 minutes, 06:00-22:59 WAT
 * (05-21 UTC), so nobody is paged overnight about an all-night calendar.
 * Each event is nudged once; see reminders.nudgeUpcoming.
 */
crons.cron("meeting nudges", "*/5 5-21 * * *", internal.reminders.nudgeUpcoming, {});

/**
 * Ops (2026-10-15). Connection check at 06:30 WAT (05:30 UTC) so a dead
 * token is reported before the 07:00 check-in needs it. Heartbeat every 10
 * minutes for the outside watchdog. Warning digest at 19:00 WAT (18:00 UTC).
 */
crons.cron("connection check", "30 5 * * *", internal.ops.checkConnections, {});
crons.interval("heartbeat", { minutes: 10 }, internal.ops.heartbeat, {});
crons.cron("ops digest", "0 18 * * *", internal.ops.digest, {});

// Phase 12 adds: evening brief 0 19 * * *

export default crons;
