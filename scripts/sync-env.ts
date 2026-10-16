// Rebuild .env.dev from the dev deployment and .env.prod from dev + prod's
// own secrets. Prints names only, never values. Writes files; pushing to prod
// is a separate command you run after reading the report:
//
//   bun scripts/sync-env.ts
//   bunx convex env set --prod --force --from-file .env.prod
//
// Old files are kept as .env.dev.bak / .env.prod.bak (gitignored).

import { existsSync, copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { parseEnv, mergeForProd } from "./env-merge";

function convexEnvList(prod: boolean): string {
  const args = ["bunx", "convex", "env", "list", ...(prod ? ["--prod"] : [])];
  const r = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    console.error(`✗ ${args.join(" ")} failed:\n${r.stderr.toString().slice(0, 500)}`);
    process.exit(1);
  }
  return r.stdout.toString();
}

const devText = convexEnvList(false);
const prodText = convexEnvList(true);
const dev = parseEnv(devText);
if (dev.size === 0) {
  console.error("✗ the dev deployment listed no variables; nothing written");
  process.exit(1);
}
const prodFile = existsSync(".env.prod") ? parseEnv(readFileSync(".env.prod", "utf8")) : new Map();
const report = mergeForProd(dev, parseEnv(prodText), prodFile);

for (const f of [".env.dev", ".env.prod"]) if (existsSync(f)) copyFileSync(f, `${f}.bak`);
writeFileSync(".env.dev", [...dev.values()].map((l) => l.raw).join("\n") + "\n", { mode: 0o600 });
writeFileSync(".env.prod", report.lines.join("\n") + "\n", { mode: 0o600 });

console.log(`.env.dev  ← dev deployment: ${dev.size} variables`);
console.log(`.env.prod ← ${report.lines.length} variables`);
console.log(`  kept prod's own value: ${report.keptFromProd.join(", ") || "none"}`);
console.log(`  only on prod, kept:    ${report.prodOnlyExtras.join(", ") || "none"}`);
console.log(`  copied from dev:       ${report.fromDev.length}`);
if (report.problems.length) {
  console.log("\n✗ Fix before pushing to prod:");
  for (const p of report.problems) console.log(`  - ${p}`);
  process.exit(2);
}
console.log("\n✓ Ready. Push with:\n  bunx convex env set --prod --force --from-file .env.prod");
