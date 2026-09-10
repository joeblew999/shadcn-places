/**
 * City names from OpenStreetMap, joined by where the place is.
 *
 * The source that gets past the ceiling. Wikidata is exhausted — `rdfs:label` is
 * its densest field, `skos:altLabel` and sitelinks are subsets of it, and running
 * the label pass again returns exactly what it returned last time. Cities sat at
 * 40–61% for the largest languages and stayed there.
 *
 * OSM has different names, contributed by different people. Measured against
 * Japan: 1,143 of our cities matched, adding 1,006 Indonesian names, 746 French,
 * 514 Chinese, 485 Korean, 368 Thai — none of which Wikidata had.
 *
 * ## Why coordinates, when everything else here joins on an identifier
 *
 * Reluctantly, and with the risk stated. Subdivisions join on ISO 3166-2 because
 * OSM tags it; cities have no such code. OSM's `wikidata` tag runs from 24% in
 * Thailand to 99% in Japan, so an identifier join would silently skip three
 * quarters of some countries — which is worse than a careful spatial one, because
 * it looks complete.
 *
 * The rule is deliberately strict: nearest within ~2km, each place matched at
 * most once from each side. A city and a town two kilometres apart with different
 * names is rare; the failure mode is a missed match rather than a wrong one, and
 * a missed match costs a name we did not have anyway.
 *
 * An earlier version of this measurement matched by *name* and reported zero
 * matches in Japan and Thailand — because OSM's `name` is in Japanese and Thai
 * while ours is romanised. It concluded OSM was worthless. It was measuring the
 * join, not the data.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { records, ndjsonWriter } from "../lib/ndjson.ts"
import { isLanguageTag } from "../lib/sources.ts"
import type { MergedPlace } from "./merge.ts"

const OUT = process.env.PLACES_OUT ?? ".build"
const STAGE = process.env.PLACES_STAGE ?? ".stage"
const DIR = join(STAGE, "osm-cities")

/** Roughly two kilometres. Tight enough that a wrong match needs two same-sized places almost on top of each other. */
const RADIUS = 0.02

/**
 * Politeness, not throughput.
 *
 * Overpass is free, shared, and explicitly asks callers not to hammer it. Two at
 * a time with a pause between finishes the world in well under an hour and stays
 * a neighbour anyone would keep serving. The label pass can be six because
 * Wikidata's endpoint is sized differently; this one should not be.
 */
/**
 * Two mirrors, alternated — because one host will not carry 245 queries.
 *
 * The main instance answered Thailand in ten seconds and then rate-limited every
 * subsequent request; it is not that it refuses this workload, it is that one IP
 * gets a small number of slots and a serial run exhausts them. Two of us made
 * three requests before China came back 429.
 *
 * kumi.systems exists precisely for heavier use and is slower per query but has
 * its own budget. Alternating gets two slots instead of one and spreads the cost
 * across two volunteers rather than leaning on either. Both were measured
 * answering the same query correctly before being trusted with it.
 */
const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
]

const CONCURRENCY = Number(process.env.PLACES_OSM_CONCURRENCY ?? MIRRORS.length)
const PAUSE_MS = Number(process.env.PLACES_OSM_PAUSE_MS ?? 1500)

/**
 * `city|town` only, and not `village`.
 *
 * The first version asked for villages too and India alone returned 28MB after
 * ten minutes — India has hundreds of thousands of them, and our inventory starts
 * at five thousand people. At that rate the world was forty hours of somebody
 * else's free infrastructure for data that could not match anything.
 *
 * The two tags that can match are the two we ask for. A village below the
 * population floor has no row here to attach a name to.
 */
async function overpass(country: string, worker: number): Promise<unknown[] | null> {
  const query = `[out:json][timeout:180];
    area["ISO3166-1"="${country}"][admin_level=2]->.a;
    node[place~"^(city|town)$"](area.a);
    out;`
  /**
   * A 429 is "come back later", not "no data".
   *
   * Overpass rate-limits by IP with a small number of slots, and two concurrent
   * requests was already too many — it answered 429 for China and the first
   * version wrote that down as a country with no names. That is the failure this
   * whole project is organised against: an absence of *fetching* recorded as an
   * absence in the world.
   *
   * So a rate-limit backs off and retries rather than counting as an answer, and
   * only a persistent failure gives up — loudly, and still without writing a file,
   * so a later run picks the country up again.
   */
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      // Each worker keeps its own mirror, and a rate-limited retry moves to the
      // other one — a 429 means "this host is busy", and asking it again first is
      // the least useful thing to do.
      const endpoint = MIRRORS[(worker + attempt - 1) % MIRRORS.length]
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "shadcn-places/0.1 (https://github.com/joeblew999/shadcn-places)",
        },
        body: new URLSearchParams({ data: query }),
        signal: AbortSignal.timeout(240_000),
      })
      if (res.status === 429 || res.status === 504) {
        // Overpass sends Retry-After sometimes; when it does not, back off anyway.
        const wait = Number(res.headers.get("retry-after") ?? 0) * 1000 || attempt * 8_000
        process.stdout.write(`\r    ${country}: rate-limited, waiting ${Math.round(wait / 1000)}s (attempt ${attempt}/5)   `)
        await new Promise((r) => setTimeout(r, wait))
        continue
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return ((await res.json()) as { elements?: unknown[] }).elements ?? []
    } catch (e) {
      if (attempt === 5) {
        console.log(`\n    ${country}: ${(e as Error).message} — giving up for now, no file written so a later run retries`)
        return null
      }
      await new Promise((r) => setTimeout(r, attempt * 5_000))
    }
  }
  console.log(`\n    ${country}: still rate-limited after 5 attempts — will be retried by a later run`)
  return null
}

/** Which countries we actually have cities for. No point asking about the rest. */
async function countriesWithCities(): Promise<string[]> {
  const seen = new Map<string, number>()
  for await (const p of records<MergedPlace>(join(OUT, "cities.merged.ndjson"))) {
    if (p.country) seen.set(p.country, (seen.get(p.country) ?? 0) + 1)
  }
  // Biggest first, so an interrupted run has done the most valuable part.
  return [...seen].sort((a, b) => b[1] - a[1]).map(([cc]) => cc)
}

export async function osm(argv: string[]): Promise<void> {
  const only = argv.filter((a) => !a.startsWith("--")).map((c) => c.toUpperCase())
  const refresh = argv.includes("--refresh")
  mkdirSync(DIR, { recursive: true })

  if (!argv.includes("--extract-only")) {
    const countries = only.length ? only : await countriesWithCities()
    const todo = countries.filter((cc) => refresh || !existsSync(join(DIR, `${cc}.json`)))
    console.log(`  ${todo.length} countries to fetch (${countries.length - todo.length} already staged)`)
    console.log(`  Overpass, ${CONCURRENCY} at a time with a pause — it is free and shared\n`)

    let cursor = 0
    let done = 0
    const worker = async () => {
      for (;;) {
        const i = cursor++
        if (i >= todo.length) return
        const cc = todo[i]
        const elements = await overpass(cc, i)
        if (elements) writeFileSync(join(DIR, `${cc}.json`), JSON.stringify(elements))
        done++
        process.stdout.write(`\r  ${done}/${todo.length} countries`)
        await new Promise((r) => setTimeout(r, PAUSE_MS))
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    console.log()
  }

  // ---- match ---------------------------------------------------------------
  interface Ours { lat: number; lon: number; id: string; has: Set<string>; used: boolean }
  const byCountry = new Map<string, Ours[]>()
  for await (const p of records<MergedPlace>(join(OUT, "cities.merged.ndjson"))) {
    if (!p.country || p.lat === undefined || p.lon === undefined) continue
    const list = byCountry.get(p.country) ?? []
    list.push({
      lat: p.lat,
      lon: p.lon,
      id: p.id,
      // Only real names count as "already have": a romanised fallback is exactly
      // what OSM might replace.
      has: new Set(p.names.filter((n) => n.kind !== "romanised").map((n) => n.locale)),
      used: false,
    })
    byCountry.set(p.country, list)
  }

  const out = ndjsonWriter(join(OUT, "labels", "city-osm.ndjson"))
  let matched = 0
  let added = 0
  const perLocale = new Map<string, number>()

  for (const file of readdirSync(DIR)) {
    const cc = file.replace(/\.json$/, "")
    const ours = byCountry.get(cc)
    if (!ours) continue
    const elements = JSON.parse(readFileSync(join(DIR, file), "utf8")) as {
      lat?: number
      lon?: number
      tags?: Record<string, string>
    }[]
    for (const el of elements) {
      if (el.lat === undefined || el.lon === undefined || !el.tags) continue
      let best: Ours | undefined
      let bestDist = Infinity
      for (const o of ours) {
        if (o.used) continue
        const dLat = Math.abs(o.lat - el.lat)
        if (dLat > RADIUS) continue
        const dLon = Math.abs(o.lon - el.lon)
        if (dLon > RADIUS) continue
        const d = dLat * dLat + dLon * dLon
        if (d < bestDist) { bestDist = d; best = o }
      }
      if (!best) continue
      // One-to-one. Without this a dense cluster of OSM nodes all claim the same
      // city and its names become whichever node was read last.
      best.used = true
      matched++
      for (const [key, value] of Object.entries(el.tags)) {
        if (!key.startsWith("name:") || !value) continue
        const locale = key.slice("name:".length)
        if (locale.includes(":") || !isLanguageTag(locale)) continue
        if (best.has.has(locale)) continue
        added++
        perLocale.set(locale, (perLocale.get(locale) ?? 0) + 1)
        out.write({ placeId: best.id, locale, value, source: "osm" })
      }
    }
  }
  await out.close()

  const top = [...perLocale].sort((a, b) => b[1] - a[1]).slice(0, 12)
  console.log(`\n  ${matched.toLocaleString()} cities matched, ${added.toLocaleString()} names OSM has and we did not`)
  console.log(`  ${top.map(([l, n]) => `${l}+${n}`).join("  ")}`)
  console.log(`\n  → ${join(OUT, "labels", "city-osm.ndjson")}. Fold in with: bun run places merge cities`)
}
