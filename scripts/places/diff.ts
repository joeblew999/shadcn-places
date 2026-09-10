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
import { existsSync, readFileSync } from "node:fs"
import { join, resolve as resolvePath } from "node:path"
import { records } from "../lib/ndjson.ts"
import type { MergedPlace, Resolved } from "./merge.ts"

const OUT = process.env.PLACES_OUT ?? ".build"
const ROOT = resolvePath(import.meta.dirname, "../..")

type Snapshot = Map<string, { pivot: string; names: Map<string, Resolved> }>

/** The published artefact: what we last stood behind. */
function published(tier: string): Snapshot | null {
  const path = join(ROOT, "data", `${tier}.ndjson.gz`)
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
}

function compare(was: Snapshot, now: Snapshot): Change {
  const change: Change = {
    places: { added: 0, removed: [] },
    names: { added: 0, removed: 0, changed: 0 },
    byLocale: new Map(),
    demoted: [],
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
      if (old.value !== name.value) change.names.changed++
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

export async function diff(argv: string[]): Promise<void> {
  const tiers = argv.filter((a) => !a.startsWith("--"))
  const wanted = tiers.length ? tiers : ["countries", "subdivisions", "cities"]
  let anything = false

  for (const tier of wanted) {
    if (!existsSync(join(OUT, `${tier}.merged.ndjson`))) continue
    const was = published(tier)
    if (!was) {
      console.log(`  ${tier}: nothing published yet — this build would be the first`)
      continue
    }
    const now = await built(tier)
    const c = compare(was, now)
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

  if (anything) {
    console.log("\n  Losses are not automatically wrong — filtering the deprecated country")
    console.log("  aliases removed 23 places and that was the fix. But they should be a")
    console.log("  decision rather than a surprise, which is the whole point of looking.")
    console.log("\n  Publish this build with:")
    console.log("    for t in countries subdivisions cities; do gzip -9 -c .build/$t.merged.ndjson > data/$t.ndjson.gz; done")
  }
}
