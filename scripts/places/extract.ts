/**
 * Turn staged sources into one NDJSON row per place, keeping every language.
 *
 * A pure function of what `stage` put on disk. No network, no locale list — the
 * service has no locale list, which is the whole point of it being a service
 * rather than a table inside one application. A consumer asks for `sw` at request
 * time; if the data is there it comes back.
 *
 * "Keep every language" is not generosity, it is the cheaper code: GeoNames ships
 * one file containing all of them, so filtering to a set would be work added, not
 * saved. Measured over a 3,067-city sample it costs 2.5× the bytes on a base of
 * tens of megabytes, and it means the language somebody adopts next year is
 * already here.
 */

import { existsSync, readFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { tsv, jsonArray, ndjsonWriter } from "../lib/ndjson.ts"
import { NOT_LANGUAGES, isLanguageTag, type Kind } from "../lib/sources.ts"
/**
 * Countries and the subdivision row shape come from `src/etl/tiers.ts`.
 *
 * The Cloudflare Workflow generates the same tiers, and two definitions of "which
 * region codes are countries" or "which locales CLDR carries" would be two
 * databases. Same rule as `src/etl/geonames.ts` for cities.
 */
import { countryPlaces, parseSubdivisionRow, osmSubdivision, parseAdmin1Row } from "../../src/etl/tiers.ts"

const STAGE = process.env.PLACES_STAGE ?? ".stage"
const OUT = process.env.PLACES_OUT ?? ".build"

/** One name, and how we came to have it. The `kind` is what makes a fallback honest. */
export interface Name {
  locale: string
  value: string
  source: string
  kind: Kind
}

export interface Place {
  id: string
  type: "country" | "subdivision" | "city"
  /** The romanised name. Always present — this is what `pick` degrades to. */
  pivot: string
  parent?: string
  country?: string
  lat?: number
  lon?: number
  population?: number
  /** The Wikidata QID where a source gave us one, for the label join. */
  wikidata?: string
  names: Name[]
}

const manifest = (): Record<string, { file: string }> => {
  const p = join(STAGE, "manifest.json")
  if (!existsSync(p)) throw new Error(`nothing staged. Run: bun run places stage --sample`)
  return JSON.parse(readFileSync(p, "utf8"))
}

/** GeoNames ships zips; expand once, beside the archive. */
function expand(zip: string): string {
  const dir = zip.replace(/\.zip$/, "")
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    spawnSync("unzip", ["-o", "-q", zip, "-d", dir])
  }
  return dir
}

/**
 * Countries, from the runtime's own CLDR.
 *
 * Snapshotted rather than resolved at request time for two reasons. The wording is
 * editorial — this machine's ICU says "China mainland" and another version says
 * something else — and a name that changes under a reader because a runtime was
 * upgraded is not a name, it is a weather report. Snapshotting also lets a value
 * be corrected by hand, which a live `Intl` call never could.
 *
 * `tl` is mapped to `fil` here: ICU has no `tl` and does not error, it returns
 * English. A locale that looks configured and silently renders the wrong language
 * is the worst failure mode available.
 */

/**
 * Subdivisions: dr5hn's nineteen languages, its `native`, and GeoNames for the
 * languages dr5hn has never heard of.
 *
 * dr5hn is the better source and covers none of Thai, Vietnamese or Indonesian —
 * which for a product used in Southeast Asia is the half that matters. GeoNames
 * carries those, keyed by its own id, and the two agree on a code: GeoNames writes
 * `TH.15` where dr5hn writes `TH-15`, so a dot-for-hyphen swap joins them with no
 * name matching and no guessing.
 *
 * Only enriches rows dr5hn already has. GeoNames knows subdivisions dr5hn does
 * not, and adding them here would mean two sources disagreeing about what the
 * hierarchy *is* rather than about what to call it — a bigger question than this
 * step should decide on its own.
 */
async function* subdivisions(files: Record<string, { file: string }>): AsyncGenerator<Place> {
  const dr = files["dr5hn"]?.file
  if (!dr) return

  // geonameId → the subdivision id dr5hn would use for the same place.
  const idOf = new Map<string, string>()
  const admin1 = files["geonames-admin1"]?.file
  if (admin1) {
    for await (const r of tsv(admin1)) {
      const [code, , , geonameId] = r
      if (!code || !geonameId) continue
      idOf.set(geonameId, `subdivision:${code.replace(".", "-")}`)
    }
  }

  /**
   * OpenStreetMap, joined on the code itself.
   *
   * OSM tags an admin relation with `ISO3166-2`, and that string *is* our
   * subdivision id — `BR-SP` either way. No coordinates, no name similarity, no
   * threshold to tune: either the codes match or they do not.
   *
   * It earns its place by covering what dr5hn does not. dr5hn has nineteen
   * languages and none of them are Thai, Vietnamese, Indonesian, Swahili, Hebrew,
   * Greek or Bengali; OSM has all of those at 9-29%. Where dr5hn already has a
   * language OSM rarely improves on it, and the merge's precedence sorts that out
   * without either source needing to know about the other.
   */
  const fromOsm = new Map<string, Name[]>()
  const osm = files["osm-subdivisions"]?.file
  if (osm) {
    const doc = JSON.parse(readFileSync(osm, "utf8")) as { elements?: { tags?: Record<string, string> }[] }
    for (const el of doc.elements ?? []) {
      const code = el.tags?.["ISO3166-2"]
      if (!code) continue
      const id = `subdivision:${code}`
      const names: Name[] = []
      for (const [key, value] of Object.entries(el.tags ?? {})) {
        if (!key.startsWith("name:") || !value) continue
        // `name:prefix:xx` and similar are qualified variants, not plain names.
        const locale = key.slice("name:".length)
        if (locale.includes(":") || !isLanguageTag(locale)) continue
        names.push({ locale, value, source: "osm", kind: "translated" })
      }
      if (names.length) fromOsm.set(id, names)
    }
  }

  // One streamed pass, keeping every language, exactly as for cities.
  const fromGeoNames = new Map<string, Name[]>()
  const alt = files["geonames-alternates"]?.file
  if (alt && idOf.size) {
    for await (const r of tsv(join(expand(alt), "alternateNames.txt"))) {
      const [, geonameId, lang, value] = r
      if (!geonameId || !value || !lang) continue
      const id = idOf.get(geonameId)
      if (!id || !isLanguageTag(lang)) continue
      const list = fromGeoNames.get(id) ?? []
      list.push({ locale: lang, value, source: "geonames", kind: "translated" })
      fromGeoNames.set(id, list)
    }
  }
  for await (const row of jsonArray<Record<string, unknown>>(dr)) {
    const code = String(row.iso3166_2 ?? `${row.country_code}-${row.iso2}`)
    const pivot = String(row.name ?? "")
    if (!pivot) continue
    const names: Name[] = []
    const native = row.native as string | undefined
    if (native && native !== pivot) names.push({ locale: "und", value: native, source: "dr5hn", kind: "native" })
    for (const [tag, value] of Object.entries((row.translations ?? {}) as Record<string, string>)) {
      if (!value) continue
      // dr5hn spells Simplified Chinese `zh-CN` and Brazilian Portuguese `pt-BR`.
      // Kept as written: a consumer asking for `zh` gets it by locale negotiation,
      // and rewriting somebody else's tags is how a wrong mapping becomes silent.
      names.push({ locale: tag, value, source: "dr5hn", kind: value === pivot ? "romanised" : "translated" })
    }
    const id = `subdivision:${code}`
    yield {
      id,
      type: "subdivision",
      pivot,
      country: String(row.country_code ?? ""),
      parent: `country:${row.country_code}`,
      lat: Number(row.latitude) || undefined,
      lon: Number(row.longitude) || undefined,
      wikidata: (row.wikiDataId as string) || undefined,
      // dr5hn first, so its curated translation wins a tie; the merge decides the
      // rest by kind, and demotes anything identical to the pivot either way.
      // dr5hn first so its curated value wins a tie, then OSM, then GeoNames. The
      // merge decides the rest by kind and demotes anything that is really a
      // romanisation, so the order here only settles genuine ties.
      names: [...names, ...(fromOsm.get(id) ?? []), ...(fromGeoNames.get(id) ?? [])],
    }
  }
}

/** Cities: GeoNames is the inventory. Wikidata's labels are joined later. */
async function* cities(files: Record<string, { file: string }>): AsyncGenerator<Place> {
  const zip = files["geonames-cities"]?.file
  if (!zip) return
  const dir = expand(zip)
  const alt = files["geonames-alternates"]?.file
  const byId = new Map<string, Name[]>()
  const wikidata = new Map<string, string>()

  if (alt) {
    // One pass over the big file, keeping every language. 900MB expanded, so it
    // is streamed and nothing but the extracted names is retained.
    for await (const r of tsv(join(expand(alt), "alternateNames.txt"))) {
      const [, geonameId, lang, value] = r
      if (!geonameId || !value) continue
      if (lang === "wkdt") { wikidata.set(geonameId, value); continue }
      if (!isLanguageTag(lang)) continue
      const list = byId.get(geonameId) ?? []
      list.push({ locale: lang, value, source: "geonames", kind: "translated" })
      byId.set(geonameId, list)
    }
  }

  const inventory = existsSync(join(dir, "cities5000.txt")) ? "cities5000.txt" : "cities15000.txt"
  for await (const r of tsv(join(dir, inventory))) {
    const [id, name, ascii, , lat, lon, , , country, , admin1, , , , population] = r
    if (!id || !name) continue
    const names = byId.get(id) ?? []
    // The romanised form is always available and always last-resort. Recorded as
    // its own name rather than left implicit, so `kind` can say what it is.
    if (ascii && ascii !== name) names.push({ locale: "und", value: ascii, source: "geonames", kind: "romanised" })
    yield {
      id: `city:${id}`,
      type: "city",
      pivot: ascii || name,
      country,
      parent: admin1 ? `subdivision:${country}-${admin1}` : `country:${country}`,
      lat: Number(lat) || undefined,
      lon: Number(lon) || undefined,
      population: Number(population) || undefined,
      wikidata: wikidata.get(id),
      names,
    }
  }
}

export async function extract(argv: string[]): Promise<void> {
  const files = manifest()
  mkdirSync(OUT, { recursive: true })
  const only = argv.filter((a) => !a.startsWith("--"))
  const want = (t: string) => (only.length ? only.includes(t) : true)

  const tiers: [string, AsyncGenerator<Place> | Generator<Place>][] = []
  if (want("countries")) tiers.push(["countries", countryPlaces()])
  if (want("subdivisions")) tiers.push(["subdivisions", subdivisions(files)])
  if (want("cities")) tiers.push(["cities", cities(files)])

  for (const [tier, rows] of tiers) {
    const out = ndjsonWriter(join(OUT, `${tier}.ndjson`))
    let names = 0
    const languages = new Set<string>()
    for await (const place of rows as AsyncGenerator<Place>) {
      names += place.names.length
      for (const n of place.names) languages.add(n.locale)
      out.write(place)
    }
    const count = await out.close()
    console.log(`  ${tier.padEnd(13)} ${String(count).padStart(7)} places  ${String(names).padStart(8)} names  ${languages.size} languages`)
  }
  console.log(`\nwritten to ${OUT}/. No network was used; re-run after adding a language and it costs this much again.`)
}
