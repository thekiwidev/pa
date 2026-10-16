// Pure helpers for scripts/sync-env.ts. Values pass through untouched and
// are never printed: reports carry names only.

/** Names whose prod value must stay prod's own (docs/RUNBOOK-production.md step 3). */
export const PROD_ONLY = [
  "ENCRYPTION_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "GOOGLE_REDIRECT_URI",
  "GOOGLE_PUBSUB_TOPIC",
  "GOOGLE_PUBSUB_AUDIENCE",
  "HEALTHCHECK_PING_URL",
] as const;

/** Fragments that only ever belong to dev. Seeing one in prod is a bug. */
export const DEV_MARKERS = ["coordinated-owl-164", "gmail-push-dev"];

export interface EnvLine {
  name: string;
  value: string;
  /** The line exactly as read, so it is written back exactly as read. */
  raw: string;
}

/** Parse `convex env list` output or a .env file: NAME=value per line. */
export function parseEnv(text: string): Map<string, EnvLine> {
  const out = new Map<string, EnvLine>();
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw);
    if (!m) continue;
    let value = m[2]!.trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    out.set(m[1]!, { name: m[1]!, value, raw: raw.trim() });
  }
  return out;
}

export interface MergeReport {
  lines: string[];
  fromDev: string[];
  keptFromProd: string[];
  prodOnlyExtras: string[];
  /** Blocking: prod would run with a missing or dev-valued secret. */
  problems: string[];
}

/**
 * prod = every dev variable, except PROD_ONLY names, which keep prod's value
 * (live deployment first, then the old .env.prod). Variables that exist only
 * on prod are kept too.
 */
export function mergeForProd(
  dev: Map<string, EnvLine>,
  prodLive: Map<string, EnvLine>,
  prodFile: Map<string, EnvLine>,
): MergeReport {
  const report: MergeReport = { lines: [], fromDev: [], keptFromProd: [], prodOnlyExtras: [], problems: [] };
  const only = new Set<string>(PROD_ONLY);
  const names = [...new Set([...dev.keys(), ...prodLive.keys(), ...PROD_ONLY])].sort();

  for (const name of names) {
    let line: EnvLine | undefined;
    if (only.has(name)) {
      line = prodLive.get(name) ?? prodFile.get(name);
      if (!line) {
        if (name !== "HEALTHCHECK_PING_URL" || dev.has(name)) report.problems.push(`${name}: no prod value on the deployment or in .env.prod`);
        continue;
      }
      if (dev.get(name)?.value === line.value) report.problems.push(`${name}: prod value is the same as dev`);
      report.keptFromProd.push(name);
    } else if (dev.has(name)) {
      line = dev.get(name)!;
      report.fromDev.push(name);
    } else {
      line = prodLive.get(name)!;
      report.prodOnlyExtras.push(name);
    }
    if (DEV_MARKERS.some((m) => line!.value.includes(m))) report.problems.push(`${name}: value points at dev`);
    report.lines.push(`${name}=${line.value.includes("\n") ? JSON.stringify(line.value) : line.value}`);
  }
  return report;
}
