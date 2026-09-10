/**
 * Bring the scheduled refresh's findings back into the pipeline.
 *
 * Without this the service has two sources of truth that diverge. Measured
 * before it existed: the deployed database held 8,221 Thai names from Wikidata
 * and the local build held 5,196. The weekly Workflow had found 3,025 that
 * existed nowhere else — and `places load` opens with `DELETE FROM name`, so the
 * next local rebuild would have deleted every one of them silently.
 *
 * The Workflow writes what it finds to R2 as well as to D1. This brings those
 * files down into `.build/labels/`, where the merge already reads every label
 * file it finds. From there they go through the same precedence as every other
 * source — an override still outranks them, a real translation still beats a
 * romanisation — and a rebuild carries them forward instead of undoing them.
 *
 * So the refresh is a *contributor* to the ETL rather than a fork of it, and the
 * rule stays what it has been throughout: the pipeline is the only thing that
 * decides what a name is.
 */

import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const OUT = process.env.PLACES_OUT ?? ".build"
const BUCKET = process.env.PLACES_BUCKET ?? "shadcn-places-archive"

function r2(args: string[]): string {
  const res = spawnSync("bun", ["x", "wrangler", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  if (res.status !== 0) throw new Error(res.stderr?.slice(0, 300) ?? "wrangler failed")
  return res.stdout
}

export async function pull(argv: string[]): Promise<void> {
  const dir = join(OUT, "labels")
  mkdirSync(dir, { recursive: true })

  // `r2 object get` needs an exact key, so the list comes first. Wrangler has no
  // JSON output for this, hence the parse — brittle, and the alternative is an
  // API token this command should not need.
  const listing = r2(["r2", "object", "list", `${BUCKET}`, "--prefix", "labels/"])
  const keys = [...listing.matchAll(/labels\/[A-Za-z0-9_.\-]+\.ndjson/g)].map((m) => m[0])
  const unique = [...new Set(keys)]

  if (!unique.length) {
    console.log("  nothing in R2 to pull — the refresh has not run, or found nothing")
    return
  }

  let fetched = 0
  let skipped = 0
  for (const key of unique) {
    const local = join(dir, key.replace("labels/", "r2-"))
    // Immutable by construction: each file is named for the instance and batch
    // that produced it, so a file already here cannot have changed.
    if (existsSync(local) && !argv.includes("--refresh")) { skipped++; continue }
    const body = r2(["r2", "object", "get", `${BUCKET}/${key}`, "--pipe"])
    writeFileSync(local, body)
    fetched++
    process.stdout.write(`\r  ${fetched}/${unique.length - skipped} pulled`)
  }

  console.log(`\n  ${fetched} new, ${skipped} already local → ${dir}`)
  console.log("  Fold in with: bun run places merge")
}
