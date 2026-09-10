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
  try {
    // POST, not a query string. The Workflow doing the same thing with a batch of
    // 500 was answered 431 — Request Header Fields Too Large — and this works at
    // 250 purely by being under the ceiling. One size bump from the same failure.
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        accept: "application/sparql-results+json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "shadcn-places/0.1 (https://github.com/joeblew999/shadcn-places) label sync",
      },
      body: new URLSearchParams({ query }),
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

/**
 * Country names for the languages CLDR has never heard of.
 *
 * Countries come from `Intl.DisplayNames`, which is CLDR, which covers the
 * hundred-odd locales ICU ships — and the README said "100%, every locale ICU
 * carries" as though that were the same as every locale. It is not. Wu (81M
 * readers), Cantonese (77M), Min Nan and Hakka each had **zero country names**,
 * and the matrix duly ranked them as the worst gaps in the world.
 *
 * Wikidata has them. Every country carries P297 — its ISO 3166-1 alpha-2 code —
 * which *is* our country id, so the join is exact and needs no matching. 257
 * places in one query rather than 279 batches: this is a different shape of job
 * from the city pass and short-circuits before its machinery.
 */
async function countryLabels(locales: string[]): Promise<void> {
  const langFilter = locales.map((l) => `"${l}"`).join(", ")
  console.log(`  257 countries, ${locales.length} languages, one query — joined on P297, the ISO code
`)
  const rows = await ask(`
    SELECT ?code ?label WHERE {
      ?c wdt:P297 ?code .
      ?c rdfs:label ?label .
      FILTER(LANG(?label) IN (${langFilter}))
    }`)
  if (!rows) {
    console.error("  Wikidata did not answer — nothing written, so a later run retries")
    process.exitCode = 1
    return
  }
  const key = [...locales].sort().join(",")
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (Math.imul(31, hash) + key.charCodeAt(i)) | 0
  const slug = `${locales.length}langs-${(hash >>> 0).toString(36)}-${[...locales].sort().slice(0, 4).join("-")}`
  const out = ndjsonWriter(join(OUT, "labels", `country-${slug}.ndjson`))
  const perLocale = new Map<string, number>()
  let found = 0
  for (const r of rows) {
    const code = r.code?.value
    const value = r.label?.value
    const locale = (r.label as unknown as { "xml:lang"?: string })?.["xml:lang"]
    if (!code || !value || !locale) continue
    // Two letters, uppercase — anything else is not an ISO 3166-1 alpha-2 code
    // and would create a country id for a place that does not exist here.
    if (!/^[A-Z]{2}$/.test(code)) continue
    found++
    perLocale.set(locale, (perLocale.get(locale) ?? 0) + 1)
    out.write({ placeId: `country:${code}`, locale, value, source: "wikidata" })
  }
  await out.close()
  const top = [...perLocale].sort((a, b) => b[1] - a[1])
  console.log(`  ${found.toLocaleString()} country names`)
  console.log(`  ${top.map(([l, n]) => `${l}+${n}`).join("  ")}`)
  console.log(`\n  → ${join(OUT, "labels", `country-${slug}.ndjson`)}. Fold in with: bun run places merge`)
}

export async function labels(argv: string[]): Promise<void> {
  const localeArg = argv.find((a) => a.startsWith("--locales="))
  const tierArg = argv.includes("--subdivisions") ? "subdivision" : "city"
  /**
   * `--gaps` asks the matrix instead of taking a list.
   *
   * The whole loop in one flag: what is missing, fetch exactly that, re-ask.
   * Passing `--locales=` by hand is how a run goes stale — the codes get copied
   * out of a terminal, the data improves, and the next run re-fetches what is
   * already there. Reading the gap list at the moment of running cannot drift.
   */
  let locales: string[]
  if (argv.includes("--gaps")) {
    const { gapList } = await import("./matrix.ts")
    const gaps = await gapList(argv.includes("--remote"), tierArg)
    const n = Number(argv.find((a) => a.startsWith("--gaps="))?.slice(7) ?? 25)
    locales = gaps.slice(0, n).map((g) => g.locale)
    if (!locales.length) {
      console.log("  no gaps under 70% — nothing to fetch.")
      return
    }
    console.log(`  the matrix says fetch: ${locales.join(", ")}\n`)
  } else {
    locales = localeArg ? localeArg.slice("--locales=".length).split(",") : DEFAULT_LOCALES
  }
  if (argv.includes("--countries")) return countryLabels(locales)

  const limitArg = argv.find((a) => a.startsWith("--limit="))
  const limit = limitArg ? Number(limitArg.slice("--limit=".length)) : Infinity
  const country = argv.find((a) => a.startsWith("--country="))?.slice("--country=".length)?.toUpperCase()

  /**
   * Two tiers, two join keys, because the sources gave us different things.
   *
   * Cities carry a GeoNames id and mostly no QID — GeoNames' own `wkdt` rows
   * cover 32% — so they are found through `P1566`, Wikidata's GeoNames property,
   * which matched 76% in testing.
   *
   * Subdivisions are the opposite: dr5hn ships a `wikiDataId` on 98% of them, so
   * they can be looked up by QID directly. That is the better join where it
   * exists — an identifier rather than a property that happens to be filled in.
   */
  const tier = argv.includes("--subdivisions") ? "subdivisions" : "cities"
  const ids: string[] = []
  const qids: string[] = []
  const file = tier === "subdivisions" ? "subdivisions.merged.ndjson" : "cities.merged.ndjson"
  for await (const p of records<MergedPlace>(join(OUT, file))) {
    if (country && p.country !== country) continue
    if (tier === "subdivisions") {
      if (p.wikidata) qids.push(`${p.wikidata}|${p.id}`)
    } else {
      ids.push(p.id.replace("city:", ""))
    }
    if (ids.length >= limit || qids.length >= limit) break
  }

  const count = tier === "subdivisions" ? qids.length : ids.length
  console.log(`  ${count.toLocaleString()} ${tier}, ${locales.length} languages, batches of ${BATCH}`)
  console.log(`  joined on ${tier === "subdivisions" ? "the QID dr5hn supplies" : "P1566 — Wikidata's GeoNames id"}, so no name matching is involved\n`)

  /**
   * One file per locale set, not one file overwritten.
   *
   * The first version wrote `city-labels.ndjson` and truncated it. So a second
   * run for a different set of languages — exactly what the coverage matrix tells
   * you to do — silently discarded the first. Twenty-five languages of labels were
   * replaced by fourteen, and nothing said so: the merge simply folded in fewer
   * names and the counts went down.
   *
   * Named by the locales it covers, so re-running the same set replaces its own
   * output and a different set sits beside it. The merge reads the directory.
   */
  /**
   * Named by a hash of the locale set, not by the set itself truncated.
   *
   * The first fix for the overwrite bug joined the locales and cut the result at
   * eighty characters — so two different sets whose first eighty characters match
   * produce the same filename and clobber each other. A thirty-language run
   * overwrote a twenty-five-language one *again*, silently, because `zh`, `vi`,
   * `wuu` and `yue` sort late and fell off the end of the name.
   *
   * Same failure as before, one layer down, and the lesson is the same: a
   * truncated identifier is not an identifier. The readable part is kept as a
   * prefix so the directory is still browsable, and the hash is what makes it
   * unique.
   */
  const key = [...locales].sort().join(",")
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = (Math.imul(31, hash) + key.charCodeAt(i)) | 0
  const slug = `${locales.length}langs-${(hash >>> 0).toString(36)}-${[...locales].sort().slice(0, 4).join("-")}`
  const out = ndjsonWriter(join(OUT, "labels", `${tier === "subdivisions" ? "subdivision" : "city"}-${slug}.ndjson`))
  let found = 0
  let skipped = 0
  // Commas, not spaces. `VALUES` wants a space-separated list and `IN()` wants a
  // comma-separated one, and building both from the same join produced a query
  // the endpoint answered with HTTP 400 — which the retry logic then correctly
  // reported as "not reached" rather than "no such name", which is the only
  // reason it was obvious the fault was ours.
  const langFilter = locales.map((l) => `"${l}"`).join(", ")

  const work = tier === "subdivisions" ? qids : ids

  /**
   * Batches in flight at once.
   *
   * This ran one request at a time: 279 queries for 69,700 cities, two seconds
   * each against a remote endpoint, ten minutes per pass — and a pass is the
   * thing you re-run every time a language is added. Almost all of that was
   * waiting.
   *
   * Six is deliberate rather than maximal. Wikidata's query service is free,
   * shared and asks callers to be reasonable; the aim is to stop wasting the
   * wall-clock, not to extract everything the endpoint will give. Six takes it to
   * under two minutes and stays a polite neighbour.
   */
  const CONCURRENCY = Number(process.env.PLACES_LABEL_CONCURRENCY ?? 6)

  const batches: string[][] = []
  for (let i = 0; i < work.length; i += BATCH) batches.push(work.slice(i, i + BATCH))

  let done = 0
  /**
   * A worker pool over a shared cursor, rather than chunked `Promise.all`.
   *
   * Chunking makes every group wait for its slowest member, and SPARQL response
   * times vary by an order of magnitude — one slow batch stalls five idle
   * workers. Pulling from a cursor keeps all six busy until the work runs out.
   */
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const index = cursor++
      if (index >= batches.length) return
      const slice = batches[index]
    let query: string
    let backToId: (key: string) => string
    if (tier === "subdivisions") {
      const pairs = new Map(slice.map((s) => [s.split("|")[0], s.split("|")[1]]))
      const values = [...pairs.keys()].map((q) => `wd:${q}`).join(" ")
      query = `
        SELECT ?c ?label WHERE {
          VALUES ?c { ${values} }
          ?c rdfs:label ?label .
          FILTER(LANG(?label) IN (${langFilter}))
        }`
      backToId = (uri) => pairs.get(uri.replace("http://www.wikidata.org/entity/", "")) ?? ""
    } else {
      const values = slice.map((id) => `"${id}"`).join(" ")
      query = `
        SELECT ?gid ?label WHERE {
          VALUES ?gid { ${values} }
          ?c wdt:P1566 ?gid .
          ?c rdfs:label ?label .
          FILTER(LANG(?label) IN (${langFilter}))
        }`
      backToId = (gid) => `city:${gid}`
    }
    const rows = await ask(query)
    if (!rows) { skipped += slice.length; continue }
    for (const r of rows) {
      const value = r.label?.value
      const locale = (r.label as unknown as { "xml:lang"?: string })?.["xml:lang"]
      const key = (r.gid ?? r.c)?.value
      if (!value || !locale || !key) continue
      const placeId = backToId(key)
      if (!placeId) continue
      found++
      out.write({ geonameId: placeId.replace(/^city:/, ""), placeId, locale, value })
    }
      done += slice.length
      process.stdout.write(`\r  ${Math.min(done, work.length)}/${work.length} ${tier} · ${found.toLocaleString()} labels`)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  await out.close()

  const written = join(OUT, "labels", `${tier === "subdivisions" ? "subdivision" : "city"}-${slug}.ndjson`)
  console.log(`\n\n  ${found.toLocaleString()} labels → ${written}`)
  if (skipped) {
    console.log(`  ${skipped.toLocaleString()} cities were not reached. They are absent from the output,`)
    console.log(`  which is not the same as having no name — re-run to fill them.`)
  }
  console.log(`\n  Fold them in with: bun run places merge ${tier}`)
}
