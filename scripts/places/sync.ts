/**
 * The whole cycle, in one command, in the right order.
 *
 * Everything this does was already possible and I ran it by hand perhaps thirty
 * times today: pull, merge, diff, load, apply, publish, deploy. Every run was an
 * opportunity to do them out of order, skip the diff, forget to re-export `data/`
 * after a fix, or load without pulling first — and I did most of those at least
 * once. The 76MB blob, the stale `data/`, the twenty-five languages of labels
 * discarded: all of them are steps-in-sequence failures rather than logic errors.
 *
 * A CLI that requires a person to remember an order is a CLI with a bug in it.
 *
 * ## The order, and why it is this order
 *
 *   pull    the scheduled refresh's findings, or the merge silently drops them
 *   merge   every source resolved by precedence — the only thing that decides a name
 *   diff    against what was last published, before anything is written
 *   load    a delta by default, because a full rewrite is 81MB to change 64 rows
 *   apply   local first, then remote: local is where a broken file is cheap
 *   publish data/ re-exported, which is both the ODbL obligation and the next diff's baseline
 *
 * Stops on a loss unless told not to. A shrinking dataset is sometimes correct —
 * filtering the deprecated country aliases removed 23 places and that was the fix
 * — but it should be a decision rather than something noticed a week later.
 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join, resolve as resolvePath } from "node:path"

const OUT = process.env.PLACES_OUT ?? ".build"
const ROOT = resolvePath(import.meta.dirname, "../..")

function run(label: string, argv: string[], opts: { quiet?: boolean } = {}): string {
  process.stdout.write(`\n── ${label}\n`)
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: opts.quiet ? ["inherit", "pipe", "pipe"] : "inherit",
  })
  if (res.status !== 0) {
    if (opts.quiet) console.error(res.stdout ?? "", res.stderr ?? "")
    throw new Error(`${label} failed`)
  }
  return res.stdout ?? ""
}

const places = (...args: string[]) => ["bun", "scripts/places.ts", ...args]
const wrangler = (...args: string[]) => ["bun", "x", "wrangler", ...args]

export async function sync(argv: string[]): Promise<void> {
  const full = argv.includes("--full")
  const force = argv.includes("--force")
  const dry = argv.includes("--dry-run")
  const skipRemote = argv.includes("--local-only")

  console.log("Syncing: pull → merge → diff → load → apply → publish")
  if (dry) console.log("(--dry-run: stopping after the diff)")

  /**
   * Pull first, always.
   *
   * The weekly refresh writes what it finds to R2 as well as to D1. Merging
   * without pulling rebuilds from local sources only, and `load` opens by
   * deleting — so a week of scheduled work disappears with nothing said. This
   * ordering is the whole reason the command exists.
   */
  run("pulling the refresh's findings", places("pull"))

  run("merging every source by precedence", places("merge"))

  // Before anything is written. A diff after the load is a post-mortem.
  const diff = run("what changed", places("diff"), { quiet: true })
  process.stdout.write(diff)

  /**
   * A loss stops the run unless somebody says otherwise.
   *
   * Parsed from the diff's own output rather than recomputed, so the number that
   * gates the run is the number the human is shown. If those two ever disagree
   * the gate is worthless.
   */
  const lost = [...diff.matchAll(/−(\d+)/g)].map((m) => Number(m[1])).reduce((a, b) => a + b, 0)
  if (lost > 0 && !force) {
    console.error(`\n  STOPPING: this build loses ${lost} place(s).`)
    console.error("  Sometimes right — filtering the deprecated country aliases removed 23 and that was the fix.")
    console.error("  Look at the diff above, then re-run with --force if it is what you meant.")
    process.exitCode = 1
    return
  }
  if (dry) { console.log("\n  --dry-run: nothing written."); return }

  run(full ? "writing a full load" : "writing a delta", places("load", ...(full ? [] : ["--delta"])))

  if (!existsSync(join(ROOT, OUT, "load.sql"))) throw new Error("no load.sql — did `load` write anything?")

  /**
   * Local before remote, always.
   *
   * A malformed load file costs seconds locally and minutes plus a half-applied
   * production database remotely. Remote D1 also refuses things local D1 accepts
   * — `BEGIN TRANSACTION`, most memorably — so local is a real check and not a
   * formality.
   */
  run("applying locally", wrangler("d1", "execute", "places", "--local", "--file=.build/load.sql"))
  if (!skipRemote) {
    run("applying to the deployed database", wrangler("d1", "execute", "places", "--remote", "--file=.build/load.sql", "-y"))
  }

  /**
   * Publishing last, and never skipped.
   *
   * `data/` is two things at once: the ODbL obligation, and the baseline the next
   * diff compares against. Forgetting it means the repository claims to publish a
   * database it is not serving *and* the next diff reports changes that already
   * shipped. It drifted exactly once and nothing noticed for an hour.
   */
  run("publishing data/", [
    "sh",
    "-c",
    "for t in countries subdivisions cities; do gzip -9 -c .build/$t.merged.ndjson > data/$t.ndjson.gz; done",
  ])

  run("checks", ["bun", "run", "check"])
  console.log("\n  Synced. `bun x wrangler deploy` if the Worker itself changed.")
}
