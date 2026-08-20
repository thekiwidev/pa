import { cronJobs } from "convex/server";

// CRON EXPRESSIONS ARE UTC. Lagos is UTC+1 with no DST, so subtract one
// hour from every local time. 07:00 WAT is "0 6 * * *".
// Write the offset in a comment above every line or you WILL misread it.
const crons = cronJobs();

// Phase 2 adds: hourly reconcile sweep
// Phase 3 adds: mailbox sync (10 min waking / 30 min overnight)
// Phase 8 adds: daily Gmail watch renewal
// Phase 12 adds: morning brief 0 6 * * *  /  evening brief 0 19 * * *

export default crons;
