// Pure. The /health readout: one line per integration, then anything that
// failed recently.

export interface CheckResult {
  name: string;
  ok: boolean;
  /** Present when ok is false — short, scrubbed. */
  detail?: string;
  /** When there is nothing to check (not configured), not a failure. */
  skipped?: boolean;
  fix?: string;
}

export function renderHealth(
  checks: CheckResult[],
  incidents: { source: string; sample: string; count: number; lastAtText: string; resolved: boolean }[],
): string {
  const lines = checks.map((c) => {
    if (c.skipped) return `▫️ ${c.name}: not set up`;
    if (c.ok) return `✅ ${c.name}`;
    return `⚠️ ${c.name}: ${c.detail ?? "failing"}${c.fix ? `\n    Fix: ${c.fix}` : ""}`;
  });
  const open = incidents.filter((i) => !i.resolved);
  if (open.length > 0) {
    lines.push("", "Recent failures:");
    for (const i of open.slice(0, 5)) {
      lines.push(`• ${i.source}: ${i.sample.slice(0, 100)} (${i.count}×, last ${i.lastAtText})`);
    }
  } else {
    lines.push("", "No open failures.");
  }
  return lines.join("\n");
}
