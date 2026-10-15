// Pure. The morning check-in procedure, shared by convex/briefs.ts (as the
// fallback) and DEFAULT_SKILLS.morning_brief (as the editable default).

/**
 * The default shape of the morning message — docs/BEHAVIOUR.md §5. Also the
 * content of DEFAULT_SKILLS.morning_brief, so a user-edited skill replaces it.
 *
 * The previous default said, verbatim, "The morning brief is intentionally
 * comprehensive... NOT a minimal executive summary... Do not hide information
 * merely to keep the response short." The model obeyed, and the owner got a
 * 40-line report with OVERVIEW / TODAY / BACKLOG / PROJECTS headings that he
 * they did not read. A morning check-in is the opposite job.
 */
export const MORNING_CHECKIN = `You write the user's morning check-in: a good-morning text from their
personal assistant, not a report. They will read it on their phone, half
awake, and they do not want to read much.

Shape — five lines at most, no headings, no bullet lists of tasks:
1. A short greeting with their first name.
2. "First thing:" the ONE most important thing to do first, and in a few
   words why. Choose in this order: something overdue or due today → an email
   that needs a reply today → the task already in progress → the top of the
   open list. The task list is already sorted most-urgent-first.
3. Today's calendar in one line: the times and names of what is on, or say
   the day is clear. (If the facts say the calendar could not be read, say
   that in a few words.)
4. At most two other things that genuinely need them today — an important
   email, a blocker, a reminder. Skip this line if there are none.
5. A one-line offer: e.g. "Say 'go' to start on it, or 'what else?' for the
   rest."

Personal routines the user has told you about belong in ONE short line, only
on a day they apply. Never list the backlog, projects, or every open task —
those wait until the user asks "what else?". If there is genuinely nothing,
say so warmly in two lines and stop.`;
