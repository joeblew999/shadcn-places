/**
 * Resolve, per (place, locale), which name wins — and record why.
 *
 * Several sources name the same place in the same language and they disagree.
 * dr5hn's German for a Thai province is usually the English string; GeoNames may
 * have a real one; Wikidata may have a better one. Picking between them by hand,
 * or by whichever source ran last, makes the output depend on the order of the
 * pipeline — which means a re-run can silently change a name.
 *
 * So precedence is a rule: `translated` beats `native` beats `transliterated`
 * beats `romanised`, and ties break on source order. Two consequences worth the
 * cost of writing it down:
 *
 *   - A transliteration added later is replaced automatically the day a real name
 *     appears upstream. Nobody has to notice.
 *   - A name that is byte-identical to the pivot is demoted to `romanised` even
 *     if its source called it a translation. That is the check the repository it
 *     came from lacked: 31% of non-Latin-script cells there held the English
 *     string while every completeness check passed.
 */

import { join } from "node:path"
import { records, ndjsonWriter } from "../lib/ndjson.ts"
import { KIND_RANK, type Kind } from "../lib/sources.ts"
import type { Place, Name } from "./extract.ts"

const OUT = process.env.PLACES_OUT ?? ".build"

/** One resolved name, with the losing candidates counted rather than kept. */
export interface Resolved {
  locale: string
  value: string
  source: string
  kind: Kind
  /** How many other sources offered a name for this locale. Diagnostic, not display. */
  alternatives: number
}

export interface MergedPlace extends Omit<Place, "names"> {
  names: Resolved[]
}

/**
 * A value identical to the pivot is a romanisation, whatever its source claims.
 *
 * For a Latin-script language that is correct and unremarkable — Ang Thong is Ang
 * Thong in German. For Thai, Russian or Korean it means nobody translated it, and
 * labelling it `translated` would make an absence look like a presence. The
 * distinction is what `kind` exists for.
 */
function actualKind(name: Name, pivot: string): Kind {
  if (name.kind === "native") return "native"
  return name.value === pivot ? "romanised" : name.kind
}

export function resolve(place: Place): Resolved[] {
  const byLocale = new Map<string, Name[]>()
  for (const n of place.names) {
    if (!n.value?.trim()) continue
    const list = byLocale.get(n.locale) ?? []
    list.push({ ...n, kind: actualKind(n, place.pivot) })
    byLocale.set(n.locale, list)
  }
  const out: Resolved[] = []
  for (const [locale, candidates] of byLocale) {
    candidates.sort((a, b) => KIND_RANK[b.kind] - KIND_RANK[a.kind])
    const best = candidates[0]
    out.push({ locale, value: best.value, source: best.source, kind: best.kind, alternatives: candidates.length - 1 })
  }
  out.sort((a, b) => a.locale.localeCompare(b.locale))
  return out
}

export async function merge(argv: string[]): Promise<void> {
  const tiers = argv.filter((a) => !a.startsWith("--"))
  const wanted = tiers.length ? tiers : ["countries", "subdivisions", "cities"]
  for (const tier of wanted) {
    const src = join(OUT, `${tier}.ndjson`)
    const out = ndjsonWriter(join(OUT, `${tier}.merged.ndjson`))
    let places = 0, kept = 0, demoted = 0, duplicates = 0
    /**
     * An id may arrive twice, and that is upstream's business rather than a bug.
     *
     * dr5hn lists four French overseas territories — Guyane, Saint-Pierre-et-
     * Miquelon, Saint-Barthélemy, Saint-Martin — as both French subdivisions and
     * entries in their own right, so `subdivision:FR-973` appears twice with
     * different rows. D1 answered with `UNIQUE constraint failed: place.id` and
     * named none of them.
     *
     * First occurrence wins, and the count is printed rather than swallowed: four
     * is upstream being reasonable about a genuinely ambiguous place, four hundred
     * would be a source that had changed shape, and the only way to tell them
     * apart is for the number to be visible every run.
     */
    const seen = new Set<string>()
    for await (const place of records<Place>(src)) {
      if (seen.has(place.id)) { duplicates++; continue }
      seen.add(place.id)
      const names = resolve(place)
      places++
      kept += names.length
      demoted += names.filter((n) => n.kind === "romanised").length
      out.write({ ...place, names } satisfies MergedPlace)
    }
    await out.close()
    const pct = kept ? Math.round((demoted / kept) * 100) : 0
    console.log(
      `  ${tier.padEnd(13)} ${String(places).padStart(7)} places  ${String(kept).padStart(8)} names  ` +
        `${String(demoted).padStart(7)} romanised (${pct}%)` +
        (duplicates ? `  ${duplicates} duplicate id(s) dropped` : ""),
    )
  }
  console.log("\n`romanised` is not a failure — for Latin-script languages it is the right answer.")
  console.log("It is a failure for th, zh, ko, ru and the rest, and that is what the report separates.")
}
