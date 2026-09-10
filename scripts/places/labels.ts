/**
 * City names in languages nobody wrote down twice — from Wikidata.
 *
 * This is the step that answers the actual requirement. GeoNames knows a city in
 * its own language and almost nothing else: measured across six countries, a city
 * of 15,000–50,000 people has a Japanese name 7% of the time and a Vietnamese one
 * 0% of the time. Wikidata has 84% and 68% for the same band. For a service used
 * in one country and read from another, that gap is the whole product.
 *
 * Joined on `P1566`, which is Wikidata's GeoNames id. Querying by that rather
 * than by name means no fuzzy matching and no wrong city with the right spelling
 * — the two databases already agree on an identifier, and using it is free.
 *
 * The endpoint is the constraint. Wide queries time out, and a timeout returns
 * nothing rather than an error, so a naive run records "no Thai name exists" for
 * a place whose Thai name simply was not fetched. Everything here exists to keep
 * that from being written down as a fact:
 *
 *   - ids are batched, small enough to come back
 *   - a failed batch is retried, and if it still fails it is *skipped*, never
 *     recorded as absent
 *   - the run reports what it could not reach, so a gap in the output can be
 *     told apart from a gap in the world
 */

import { join } from "node:path"
import { records, ndjsonWriter } from "../lib/ndjson.ts"
import type { MergedPlace } from "./merge.ts"

const OUT = process.env.PLACES_OUT ?? ".build"
const ENDPOINT = "https://query.wikidata.org/sparql"

/** Small enough that the endpoint answers, large enough that 34,135 cities is not 34,135 queries. */
const BATCH = Number(process.env.PLACES_LABEL_BATCH ?? 250)

/**
 * Which languages to ask for.
 *
 * The one place this service has a language list, and it is its own rather than
 * any consumer's — Wikidata charges a query per language, so "every language"
 * would be hundreds of passes against an endpoint that already times out. The
 * default is the set with enough Wikipedia behind them to be worth the round
 * trip; `--locales` overrides it, and a language added later is a re-run of this
 * step alone rather than of the pipeline.
 */
const DEFAULT_LOCALES = [
  "ar","bn","de","es","fa","fr","hi","id","it","ja","ko","ms","nl","pl","pt","ru","sw","th","tr","uk","ur","vi","zh",
]

interface LabelRow {
  /** GeoNames id, so the caller can join without another lookup. */
  geonameId: string
  locale: string
  value: string
}

async function ask(query: string, attempt = 1): Promise<Record<string, { value: string }>[] | null> {
  const url = new URL(ENDPOINT)
  url.searchParams.set("query", query)
  try {
    const res = await fetch(url, {
      headers: {
        accept: "application/sparql-results+json",
        "user-agent": "shadcn-places/0.1 (https://github.com/joeblew999/shadcn-places) label sync",
      },
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { results: { bindings: Record<string, { value: string }>[] } }
    return body.results.bindings
  } catch (e) {
    // Two attempts, then give up on this batch and say so. Retrying forever
    // against a timing-out endpoint is how a sync runs all night and finishes
    // with less data than it started with.
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 5_000 * attempt))
      return ask(query, attempt + 1)
    }
    console.log(`    batch failed after ${attempt} attempts (${(e as Error).message}) — skipped, not recorded as absent`)
    return null
  }
}

export async function labels(argv: string[]): Promise<void> {
  const localeArg = argv.find((a) => a.startsWith("--locales="))
  const locales = localeArg ? localeArg.slice("--locales=".length).split(",") : DEFAULT_LOCALES
  const limitArg = argv.find((a) => a.startsWith("--limit="))
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : Infinity
  const country = argv.find((a) => a.startsWith("--country="))?.slice("--country=".length)?.toUpperCase()

  // Only cities need this: countries come complete from CLDR, and subdivisions
  // are already at 98-99% from dr5hn in the languages it carries.
  const ids: string[] = []
  for await (const p of records<MergedPlace>(join(OUT, "cities.merged.ndjson"))) {
    if (country && p.country !== country) continue
    ids.push(p.id.replace("city:", ""))
    if (ids.length >= limit) break
  }

  console.log(`  ${ids.length.toLocaleString()} cities, ${locales.length} languages, batches of ${BATCH}`)
  console.log(`  joined on P1566 — Wikidata's GeoNames id, so no name matching is involved\n`)

  const out = ndjsonWriter(join(OUT, "city-labels.ndjson"))
  let found = 0
  let skipped = 0
  // Commas, not spaces. `VALUES` wants a space-separated list and `IN()` wants a
  // comma-separated one, and building both from the same join produced a query
  // the endpoint answered with HTTP 400 — which the retry logic then correctly
  // reported as "not reached" rather than "no such name", which is the only
  // reason it was obvious the fault was ours.
  const langFilter = locales.map((l) => `"${l}"`).join(", ")

  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH)
    const values = slice.map((id) => `"${id}"`).join(" ")
    const query = `
      SELECT ?gid ?label WHERE {
        VALUES ?gid { ${values} }
        ?c wdt:P1566 ?gid .
        ?c rdfs:label ?label .
        FILTER(LANG(?label) IN (${langFilter}))
      }`
    const rows = await ask(query)
    if (!rows) { skipped += slice.length; continue }
    for (const r of rows) {
      const value = r.label?.value
      const locale = (r.label as unknown as { "xml:lang"?: string })?.["xml:lang"]
      const geonameId = r.gid?.value
      if (!value || !locale || !geonameId) continue
      found++
      out.write({ geonameId, locale, value } satisfies LabelRow)
    }
    const done = Math.min(i + BATCH, ids.length)
    process.stdout.write(`\r  ${done}/${ids.length} cities · ${found.toLocaleString()} labels`)
  }
  await out.close()

  console.log(`\n\n  ${found.toLocaleString()} labels → ${join(OUT, "city-labels.ndjson")}`)
  if (skipped) {
    console.log(`  ${skipped.toLocaleString()} cities were not reached. They are absent from the output,`)
    console.log(`  which is not the same as having no name — re-run to fill them.`)
  }
  console.log("\n  Fold them in with: bun run places merge cities")
}
