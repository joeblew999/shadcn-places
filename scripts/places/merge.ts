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

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, resolve as resolvePath } from "node:path"
import { records, ndjsonWriter } from "../lib/ndjson.ts"
/**
 * The decision itself lives in `src/etl/resolve.ts` and is imported, not repeated.
 *
 * `merge` is the only step in this pipeline that decides anything, and the
 * Cloudflare Workflow has to make the same decision. Two implementations would be
 * two databases — which this project has already shipped three times, most
 * recently when the Cloudflare staging quietly dropped a field the CLI kept.
 *
 * What stays here is what is genuinely local: reading the filesystem, walking the
 * label directory, the counters and the report.
 */
import { resolve, type Place, type Name, type Overrides, type Resolved, type MergedPlace } from "../../src/etl/resolve.ts"

export { resolve }
export type { Resolved, MergedPlace, Overrides }

const OUT = process.env.PLACES_OUT ?? ".build"

/** One resolved name, with the losing candidates counted rather than kept. */
/**
 * Corrections from `overrides.json`, keyed by place id.
 *
 * Read once and applied in the merge rather than after it, so an override
 * competes through the same precedence rule as everything else instead of being
 * stamped on top afterwards. That matters for one case: a `why` explaining that
 * upstream is wrong stops being true the day upstream fixes it, and going
 * through the ranking means the override still wins — visibly, as
 * `kind: "override"` — rather than silently.
 */

export function loadOverrides(root = resolvePath(import.meta.dirname, "../..")): Overrides {
  const path = join(root, "overrides.json")
  if (!existsSync(path)) return {}
  const file = JSON.parse(readFileSync(path, "utf8")) as { names?: Record<string, Record<string, string>> }
  const out: Overrides = {}
  for (const [id, entry] of Object.entries(file.names ?? {})) {
    const names: Record<string, string> = {}
    // `why` is documentation and `$comment` is for the reader; neither is a locale.
    for (const [k, v] of Object.entries(entry)) if (k !== "why" && !k.startsWith("$")) names[k] = v
    if (Object.keys(names).length) out[id] = names
  }
  return out
}


/**
 * City names fetched from Wikidata by `places labels`, keyed by GeoNames id.
 *
 * Folded in here rather than in `extract` because it is the one input that
 * arrives out of band: `extract` is a pure function of what `stage` downloaded,
 * and a SPARQL run is neither downloaded nor pure. Reading it at merge time keeps
 * that promise intact — `extract` can still be re-run offline — while letting a
 * label pass improve the output without a full rebuild.
 *
 * Absent file means absent labels, not an error. The pipeline has to work for
 * somebody who never runs the SPARQL step.
 */
function loadLabels(): Map<string, Name[]> {
  const out = new Map<string, Name[]>()
  // Every label file, from every run. They are keyed by the locale set they
  // cover, so several coexist and each replaces only itself.
  const dir = join(OUT, "labels")
  const files = [
    ...(existsSync(dir) ? readdirSync(dir).map((f) => join(dir, f)) : []),
    // The single-file form the first version wrote, so an older build still folds in.
    ...["city", "subdivision"].map((t) => join(OUT, `${t}-labels.ndjson`)),
  ]
  for (const path of files) {
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, "utf8").trimEnd().split("\n")) {
      if (!line) continue
      const row = JSON.parse(line) as { geonameId?: string; placeId?: string; locale: string; value: string; source?: string }
      // `placeId` is the current field; `geonameId` is what the first version of
      // the city pass wrote, and a run from before this change should still fold in
      // rather than being silently ignored.
      const id = row.placeId ?? (row.geonameId ? `city:${row.geonameId}` : "")
      if (!id) continue
      const list = out.get(id) ?? []
      // The source travels with the row where the file records one — OSM and
      // Wikidata both land here and an attribution line has to tell them apart.
      list.push({ locale: row.locale, value: row.value, source: row.source ?? "wikidata", kind: "translated" })
      out.set(id, list)
    }
  }
  return out
}

export async function merge(argv: string[]): Promise<void> {
  const overrides = loadOverrides()
  const labels = loadLabels()
  if (labels.size) console.log(`  folding in ${labels.size.toLocaleString()} places' worth of fetched labels`)
  const tiers = argv.filter((a) => !a.startsWith("--"))
  const wanted = tiers.length ? tiers : ["countries", "subdivisions", "cities"]
  for (const tier of wanted) {
    const src = join(OUT, `${tier}.ndjson`)
    const out = ndjsonWriter(join(OUT, `${tier}.merged.ndjson`))
    let places = 0, kept = 0, demoted = 0, duplicates = 0, overridden = 0
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
      const extra = labels.get(place.id)
      if (extra) place.names.push(...extra)
      const names = resolve(place, overrides)
      if (overrides[place.id]) overridden++
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
        (duplicates ? `  ${duplicates} duplicate id(s) dropped` : "") +
        (overridden ? `  ${overridden} overridden` : ""),
    )
  }
  console.log("\n`romanised` is not a failure — for Latin-script languages it is the right answer.")
  console.log("It is a failure for th, zh, ko, ru and the rest, and that is what the report separates.")
}
