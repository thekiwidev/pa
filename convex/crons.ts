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
// Phase 12 adds: morning brief 0 6 * * *  /  evening brief 0 19 * * *

export default crons;
