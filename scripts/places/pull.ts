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

/**
 * `--remote`, always. Without it wrangler reads local simulated storage.
 *
 * This cost an hour. The Workflow reported its R2 writes as successful, the CLI
 * said "The specified key does not exist", and both were telling the truth about
 * different buckets: `wrangler r2 object get` defaults to the local dev
 * simulation, which was empty, while the deployed Worker had been writing to the
 * real one all along.
 *
 * Settled by probing the binding from inside a request — the only place that can
 * see what the Workflow sees. Every read here is remote by construction so the
 * question cannot come back.
 */
function r2(args: string[]): string {
  const res = spawnSync("bun", ["x", "wrangler", ...args, "--remote"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  if (res.status !== 0) throw new Error(res.stderr?.slice(0, 300) ?? "wrangler failed")
  return res.stdout
}

export async function pull(argv: string[]): Promise<void> {
  const dir = join(OUT, "labels")
  mkdirSync(dir, { recursive: true })

  /**
   * The index, because `wrangler r2 object` cannot list a bucket.
   *
   * It has get, put and delete and nothing else — so there is no way from the CLI
   * to ask what a refresh produced. The first version of this parsed the output of
   * `r2 object list`, a command that does not exist; it was committed and its
   * tests passed because they only checked the file was present.
   *
   * The Workflow knows what it wrote, so it publishes a manifest at a fixed key
   * and this asks for that by name. One known key is all the CLI can do, and it
   * turns out to be enough.
   */
  let index: { keys: string[] }
  try {
    index = JSON.parse(r2(["r2", "object", "get", `${BUCKET}/labels-index.json`, "--pipe"]))
  } catch {
    console.log("  no labels-index.json in R2 — the refresh has not completed a run yet")
    return
  }
  const unique = [...new Set(index.keys ?? [])]

  if (!unique.length) {
    console.log("  the refresh has run and found nothing to add")
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
