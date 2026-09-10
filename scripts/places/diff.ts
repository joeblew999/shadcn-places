/**
 * What a rebuild changed, before anyone serves it.
 *
 * The pipeline replaces the database wholesale — `load.sql` opens with two
 * DELETEs — which is what makes a re-run idempotent and also what makes it
 * dangerous. Upstream is somebody else's project. A source can rename its ids,
 * drop a language, regress a translation or ship a bad release, and the ETL will
 * carry all of it through without complaint, because "fewer names than last time"
 * is not an error condition anywhere in it.
 *
 * The published artefacts in `data/` are the last thing we vouched for. So this
 * compares the new build against them and reports the difference in the terms a
 * person actually decides on: did we lose places, did we lose languages, did a
 * name change under a reader who had already seen it.
 *
 * It is deliberately not a gate. Some regressions are correct — the day the
 * deprecated country aliases were filtered out, 23 places disappeared and that was
 * the fix. A tool that refuses to let you ship a smaller number would have blocked
 * it. Judgement stays with the person; this makes sure they have the numbers.
 */

import { gunzipSync } from "node:zlib"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve as resolvePath } from "node:path"
import { records } from "../lib/ndjson.ts"
import type { MergedPlace, Resolved } from "./merge.ts"

const ROOT = resolvePath(import.meta.dirname, "../..")
/** Resolved against ROOT so an absolute PLACES_OUT works, and so cwd does not matter. */
const OUT = resolvePath(ROOT, process.env.PLACES_OUT ?? ".build")
/**
 * Where the last publish lives. Overridable so this can be pointed at an older one.
 *
 * `data/` is the answer in every real run. It is a variable so that a test can
 * compare two known snapshots, and so that a genuine past release can be restored
 * and diffed against — which is how the history file got its first entry without
 * anybody inventing one.
 */
const DATA = process.env.PLACES_DATA ?? join(ROOT, "data")

type Snapshot = Map<string, { pivot: string; names: Map<string, Resolved> }>

/** The published artefact: what we last stood behind. */
function published(tier: string): Snapshot | null {
  const path = join(DATA, `${tier}.ndjson.gz`)
  if (!existsSync(path)) return null
  const out: Snapshot = new Map()
  for (const line of gunzipSync(readFileSync(path)).toString("utf8").trimEnd().split("\n")) {
    if (!line) continue
    const p = JSON.parse(line) as MergedPlace
    out.set(p.id, { pivot: p.pivot, names: new Map(p.names.map((n) => [n.locale, n])) })
  }
  return out
}

async function built(tier: string): Promise<Snapshot> {
  const out: Snapshot = new Map()
  for await (const p of records<MergedPlace>(join(OUT, `${tier}.merged.ndjson`))) {
    out.set(p.id, { pivot: p.pivot, names: new Map(p.names.map((n) => [n.locale, n])) })
  }
  return out
}

interface Change {
  places: { added: number; removed: string[] }
  names: { added: number; removed: number; changed: number }
  /** Per locale: how the count moved. Negative is a language losing coverage. */
  byLocale: Map<string, number>
  /** A name that was a real translation and is now a fallback. The one to look at. */
  demoted: string[]
  /**
   * Every name whose value moved, as `id locale: before → after`.
   *
   * Collected rather than only counted, because it is the answer to the one
   * question `diff` could never answer: *when did this name change, and to what*.
   * A count says something moved; a person chasing a bad translation needs the
   * two strings.
   *
   * Capped, because a full rebuild after a source release can move six figures of
   * rows and this ends up in a file that is committed. `truncated` says when the
   * list is not the whole story rather than letting it look complete.
   */
  edits: string[]
  truncated: number
}

/**
 * How many edited names one publish records.
 *
 * Today's OSM fold-in moved 110 names across the two tiers that changed, so this
 * is roughly forty publishes of headroom before it ever bites. It is here so that
 * the day a source renames every row, the history file grows by a page instead of
 * by the database.
 */
const MAX_EDITS = 5000

function compare(was: Snapshot, now: Snapshot): Change {
  const change: Change = {
    places: { added: 0, removed: [] },
    names: { added: 0, removed: 0, changed: 0 },
    byLocale: new Map(),
    demoted: [],
    edits: [],
    truncated: 0,
  }
  const bump = (locale: string, by: number) => change.byLocale.set(locale, (change.byLocale.get(locale) ?? 0) + by)

  for (const [id, after] of now) {
    const before = was.get(id)
    if (!before) {
      change.places.added++
      for (const locale of after.names.keys()) bump(locale, 1)
      change.names.added += after.names.size
      continue
    }
    for (const [locale, name] of after.names) {
      const old = before.names.get(locale)
      if (!old) { change.names.added++; bump(locale, 1); continue }
      if (old.value !== name.value) {
        change.names.changed++
        if (change.edits.length < MAX_EDITS) {
          change.edits.push(`${id} ${locale}: ${old.value} → ${name.value}`)
        } else {
          change.truncated++
        }
      }
      /**
       * A real translation becoming a fallback is the regression that matters.
       *
       * The count can hold steady while quality falls: a source replaces a Thai
       * name with a transliteration and the totals do not move at all. `kind` is
       * what makes that visible, which is most of the reason it exists.
       */
      const wasReal = old.kind === "translated" || old.kind === "native" || old.kind === "override"
      const isReal = name.kind === "translated" || name.kind === "native" || name.kind === "override"
      if (wasReal && !isReal) change.demoted.push(`${id} ${locale}: ${old.value} (${old.kind}) → ${name.value} (${name.kind})`)
    }
    for (const [locale] of before.names) {
      if (!after.names.has(locale)) { change.names.removed++; bump(locale, -1) }
    }
  }
  for (const [id] of was) if (!now.has(id)) change.places.removed.push(id)
  return change
}

/**
 * The shape written to `.build/change.json` for `places history` to pick up.
 *
 * Separate from the console output on purpose. The printed version is for a
 * person deciding whether to ship; this is the same comparison kept so that in
 * six weeks somebody can ask when a name moved and get an answer rather than a
 * shrug. `places diff` computed all of it and threw it away every time.
 */
export interface TierChange {
  tier: string
  places: { before: number; after: number; added: number; removed: string[] }
  names: { after: number; added: number; removed: number; changed: number }
  /** Net name delta per locale. The series behind "when did Thai coverage jump". */
  byLocale: Record<string, number>
  /** Real translations that became fallbacks. */
  demoted: string[]
  /** `id locale: before → after`, capped. */
  edits: string[]
  /** How many edits did not fit. Zero means the list above is complete. */
  truncated: number
}

export async function diff(argv: string[]): Promise<void> {
  const tiers = argv.filter((a) => !a.startsWith("--"))
  const wanted = tiers.length ? tiers : ["countries", "subdivisions", "cities"]
  let anything = false
  const recorded: TierChange[] = []

  for (const tier of wanted) {
    if (!existsSync(join(OUT, `${tier}.merged.ndjson`))) continue
    const was = published(tier)
    if (!was) {
      console.log(`  ${tier}: nothing published yet — this build would be the first`)
      continue
    }
    const now = await built(tier)
    const c = compare(was, now)

    /**
     * Recorded before the "did anything move" test, not after.
     *
     * An unchanged tier is a fact worth keeping: without it the history has a
     * gap where a publish happened and cannot distinguish "nothing changed" from
     * "nobody ran it".
     */
    let names = 0
    for (const p of now.values()) names += p.names.size
    recorded.push({
      tier,
      places: { before: was.size, after: now.size, added: c.places.added, removed: c.places.removed },
      names: { after: names, added: c.names.added, removed: c.names.removed, changed: c.names.changed },
      byLocale: Object.fromEntries(c.byLocale),
      demoted: c.demoted,
      edits: c.edits,
      truncated: c.truncated,
    })
    const moved =
      c.places.added || c.places.removed.length || c.names.added || c.names.removed || c.names.changed
    if (!moved) { console.log(`  ${tier.padEnd(13)} unchanged`); continue }
    anything = true

    console.log(`\n  ${tier}`)
    console.log(`    places   +${c.places.added}  −${c.places.removed.length}   (${was.size} → ${now.size})`)
    console.log(`    names    +${c.names.added}  −${c.names.removed}  ~${c.names.changed}`)

    const losers = [...c.byLocale].filter(([, n]) => n < 0).sort((a, b) => a[1] - b[1]).slice(0, 8)
    const winners = [...c.byLocale].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 8)
    if (winners.length) console.log(`    gained   ${winners.map(([l, n]) => `${l}+${n}`).join("  ")}`)
    if (losers.length) console.log(`    LOST     ${losers.map(([l, n]) => `${l}${n}`).join("  ")}`)

    if (c.places.removed.length) {
      console.log(`    places gone: ${c.places.removed.slice(0, 6).join(", ")}${c.places.removed.length > 6 ? ` …and ${c.places.removed.length - 6} more` : ""}`)
    }
    if (c.demoted.length) {
      console.log(`\n    ${c.demoted.length} name(s) went from a real translation to a fallback:`)
      for (const d of c.demoted.slice(0, 5)) console.log(`      ${d}`)
      if (c.demoted.length > 5) console.log(`      …and ${c.demoted.length - 5} more`)
    }
  }

  /**
   * Always written, even when nothing moved.
   *
   * `places history --append` reads this after the publish succeeds. Writing it
   * here rather than recomputing there means the number that goes into the record
   * is the number the person was shown — the same rule that makes `sync` parse the
   * loss count out of the printed diff instead of computing its own.
   */
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, "change.json"), JSON.stringify({ at: new Date().toISOString(), tiers: recorded }, null, 2))

  if (anything) {
    console.log("\n  Losses are not automatically wrong — filtering the deprecated country")
    console.log("  aliases removed 23 places and that was the fix. But they should be a")
    console.log("  decision rather than a surprise, which is the whole point of looking.")
    console.log("\n  Publish this build with:")
    console.log("    for t in countries subdivisions cities; do gzip -9 -c .build/$t.merged.ndjson > data/$t.ndjson.gz; done")
  }
}
