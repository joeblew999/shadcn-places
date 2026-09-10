/**
 * When did this change, and to what.
 *
 * `places diff` compares the build against the last publish, which answers *what
 * is about to change* and nothing at all about *what changed in March*. Every run
 * computed a full comparison — every added name, every demotion, every edited
 * value — printed six lines of it and threw the rest away.
 *
 * So a name that was right in one release and wrong in the next had no trail. The
 * only way to find out when a translation regressed was to check out old commits
 * and rebuild, which nobody was ever going to do.
 *
 * This keeps the comparison. `places diff` writes `.build/change.json`, `places
 * history --append` folds it in after a publish succeeds, and `places history
 * <what>` reads it back.
 *
 * ## Why a file in the repository rather than a table
 *
 * Because the question is asked weeks later and by a person. D1 would mean a
 * query, a binding and a cost per read, for data written once a week and read
 * approximately never — and it would not be in the ODbL dumps, so anyone
 * self-hosting would get the database without its provenance.
 *
 * Gzipped NDJSON beside `data/` is the same shape as everything else published
 * here, is diffable in the sense that matters (a new line per publish), and costs
 * nothing until somebody asks.
 *
 * ## What it does not keep
 *
 * Every *added* name. Today's OSM fold-in added 118,333 of them, and a list of
 * those is the database again rather than a record of it. Additions are kept as
 * per-locale counts, which is what "when did Thai coverage jump" actually needs.
 * Edits, demotions and removals are kept in full, because those are the ones
 * somebody chases by name.
 */

import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { gunzipSync, gzipSync } from "node:zlib"
import { join, resolve as resolvePath } from "node:path"
import type { TierChange } from "./diff.ts"

const ROOT = resolvePath(import.meta.dirname, "../..")
/**
 * Resolved against ROOT, which also makes an absolute override work.
 *
 * `join(ROOT, OUT)` silently produces `<root>/tmp/...` when PLACES_OUT is an
 * absolute path, so this read a file that was never there and appended nothing.
 * `resolve` returns an absolute argument unchanged, which is the behaviour both
 * callers assumed all along.
 */
const OUT = resolvePath(ROOT, process.env.PLACES_OUT ?? ".build")
/** Same override as `places diff`, so a test can keep its history out of the repo. */
const DATA = process.env.PLACES_DATA ?? join(ROOT, "data")
const FILE = join(DATA, "history.ndjson.gz")

interface Entry {
  at: string
  /** The commit the build came from, when there is one. */
  sha?: string
  /** Recomputed after the fact from an older published snapshot, not written at the time. */
  reconstructed?: boolean
  tiers: TierChange[]
}

function read(): Entry[] {
  if (!existsSync(FILE)) return []
  const text = gunzipSync(readFileSync(FILE)).toString("utf8").trimEnd()
  if (!text) return []
  return text.split("\n").map((line) => JSON.parse(line) as Entry)
}

function write(entries: Entry[]): void {
  mkdirSync(DATA, { recursive: true })
  const body = entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
  // Level 9: written once a week, read by a human, committed forever.
  writeFileSync(FILE, gzipSync(Buffer.from(body), { level: 9 }))
}

/** The commit this build came from, or undefined outside a checkout. */
function head(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim()
  } catch {
    return undefined
  }
}

/**
 * Backfill: record a comparison as belonging to a commit other than HEAD.
 *
 * Only for reconstructing a publish that already happened, which is how this file
 * got its first entry — `PLACES_DATA` pointed at the previous release, `places
 * diff` recomputed exactly what that publish changed, and this stamped it with
 * the commit that shipped it rather than with today's HEAD.
 *
 * Marked `reconstructed` so nobody later reads a derived entry as a contemporary
 * one. A record that quietly claims to have been written at the time is worse
 * than no record, which is the same argument as everything else here.
 */
function append(sha?: string, reconstructed = false): void {
  const path = join(OUT, "change.json")
  if (!existsSync(path)) {
    console.error(`  no ${OUT}/change.json — run \`places diff\` first, or \`places sync\`, which does`)
    process.exitCode = 1
    return
  }
  const change = JSON.parse(readFileSync(path, "utf8")) as { at: string; tiers: TierChange[] }
  const entries = read()

  /**
   * The same build is not recorded twice.
   *
   * `sync` runs `diff` for the gate and appends after publishing, and somebody
   * re-running a failed sync would otherwise write the identical comparison
   * again. Keyed on the diff's own timestamp, which is stamped once per `diff`
   * run — so a genuine re-diff is a new entry and a re-append is not.
   */
  if (entries.some((e) => e.at === change.at)) {
    console.log(`  already recorded ${change.at} — nothing to append`)
    return
  }

  const moved = change.tiers.filter(
    (t) => t.places.added || t.places.removed.length || t.names.added || t.names.removed || t.names.changed,
  )
  if (!moved.length) {
    console.log("  nothing changed in this build — not recorded")
    return
  }

  entries.push({
    at: change.at,
    sha: sha ?? head(),
    ...(reconstructed ? { reconstructed: true } : {}),
    tiers: change.tiers,
  })
  // Oldest first, so a backfilled entry lands where it belongs rather than at the
  // end. `places history <locale>` prints a running total and an out-of-order
  // entry would make it climb and fall for no reason.
  entries.sort((a, b) => a.at.localeCompare(b.at))
  write(entries)
  const totals = moved.reduce(
    (a, t) => ({
      added: a.added + t.names.added,
      changed: a.changed + t.names.changed,
      demoted: a.demoted + t.demoted.length,
    }),
    { added: 0, changed: 0, demoted: 0 },
  )
  const size = readFileSync(FILE).length
  console.log(
    `  recorded ${change.at}: +${totals.added.toLocaleString()} names, ` +
      `~${totals.changed.toLocaleString()} edited, ${totals.demoted.toLocaleString()} demoted ` +
      `→ data/history.ndjson.gz (${entries.length} publishes, ${(size / 1024).toFixed(0)}KB)`,
  )
}

/** `2026-09-10T11:49:03.123Z` → `2026-09-10`. Nobody asks what minute a name changed. */
const day = (at: string) => at.slice(0, 10)

function show(query: string | undefined, limit: number): void {
  const entries = read()
  if (!entries.length) {
    console.log("  no history yet. It accumulates one entry per publish, from the next `places sync`.")
    return
  }

  if (!query) {
    console.log(`  ${entries.length} publish(es) recorded\n`)
    for (const e of entries.slice(-limit)) {
      const summary = e.tiers
        .filter((t) => t.names.added || t.names.changed || t.names.removed || t.places.removed.length)
        .map((t) => {
          const bits = [`+${t.names.added}`]
          if (t.names.changed) bits.push(`~${t.names.changed}`)
          if (t.names.removed) bits.push(`−${t.names.removed}`)
          if (t.demoted.length) bits.push(`${t.demoted.length} demoted`)
          return `${t.tier} ${bits.join(" ")}`
        })
      const mark = e.reconstructed ? " ~" : "  "
      console.log(`  ${day(e.at)}  ${e.sha ?? "".padEnd(7)}${mark} ${summary.join("   ") || "no change"}`)
    }
    if (entries.some((e) => e.reconstructed)) {
      console.log(`\n  ~ reconstructed after the fact from an older published snapshot.`)
    }
    console.log(`\n  \`places history <locale>\` for one language, \`places history <place id>\` for one place.`)
    return
  }

  /**
   * A place id, a locale, or a substring of a name — decided by what it looks like.
   *
   * Three separate flags would be more precise and would mean remembering which
   * one to use. `city:1609350` is unambiguous, a two-or-three letter tag is a
   * locale, and anything else is a search.
   */
  const isPlace = /^(country|subdivision|city):/.test(query)
  const isLocale = /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(query)

  if (isLocale) {
    console.log(`  ${query}: names added or lost, per publish\n`)
    let running = 0
    for (const e of entries) {
      const delta = e.tiers.reduce((n, t) => n + (t.byLocale[query] ?? 0), 0)
      if (!delta) continue
      running += delta
      const sign = delta > 0 ? "+" : ""
      console.log(`  ${day(e.at)}  ${e.sha ?? "-".padEnd(7)}  ${sign}${delta.toLocaleString().padStart(8)}   running ${running.toLocaleString()}`)
    }
    if (!running) console.log("  no change to this language in any recorded publish")
    // The demotions matter more than the count and are easy to miss inside it.
    const demotions = entries.flatMap((e) =>
      e.tiers.flatMap((t) => t.demoted.filter((d) => d.includes(` ${query}:`)).map((d) => [e.at, d] as const)),
    )
    if (demotions.length) {
      console.log(`\n  ${demotions.length} became a fallback again:`)
      for (const [at, d] of demotions.slice(-limit)) console.log(`  ${day(at)}  ${d}`)
    }
    return
  }

  const match = (line: string) => (isPlace ? line.startsWith(`${query} `) : line.toLowerCase().includes(query.toLowerCase()))
  const hits: string[] = []
  for (const e of entries) {
    for (const t of e.tiers) {
      for (const line of t.edits) if (match(line)) hits.push(`  ${day(e.at)}  ${e.sha ?? "-"}  ${line}`)
      for (const line of t.demoted) if (match(line)) hits.push(`  ${day(e.at)}  ${e.sha ?? "-"}  ${line}  [demoted]`)
      for (const id of t.places.removed) {
        if (isPlace ? id === query : id.toLowerCase().includes(query.toLowerCase())) {
          hits.push(`  ${day(e.at)}  ${e.sha ?? "-"}  ${id}  [place removed]`)
        }
      }
    }
  }
  if (!hits.length) {
    console.log(`  nothing recorded for "${query}".`)
    const truncated = entries.reduce((n, e) => n + e.tiers.reduce((m, t) => m + t.truncated, 0), 0)
    if (truncated) {
      console.log(`  ${truncated.toLocaleString()} edit(s) across all publishes did not fit the per-publish cap,`)
      console.log(`  so absence here is not proof it never changed.`)
    }
    return
  }
  console.log(`  ${hits.length} change(s) recorded for "${query}"\n`)
  for (const h of hits.slice(-limit)) console.log(h)
}

export async function history(argv: string[]): Promise<void> {
  const limitArg = argv.find((a) => a.startsWith("--limit="))
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : 40
  if (argv.includes("--append")) {
    const shaArg = argv.find((a) => a.startsWith("--sha="))
    return append(shaArg?.slice("--sha=".length), argv.includes("--reconstructed"))
  }
  show(argv.find((a) => !a.startsWith("--")), limit)
}
