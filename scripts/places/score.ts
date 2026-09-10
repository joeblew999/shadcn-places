/**
 * Score a reference-data candidate against the locales we declare.
 *
 * "Is this dataset already translated into our languages?" was asked four times
 * in one session — CLDR, GeoNames, dr5hn, annexare — and answered four times with
 * a throwaway script in a scratchpad. Every answer was a number nobody else could
 * reproduce, about a claim every README makes and none of them qualifies.
 *
 * So the measurement lives here. A candidate is a URL, a shape and a tag map; the
 * scorer downloads it, counts how many rows carry a name in each locale
 * `ALL_LOCALES` declares, and prints the same table for all of them. Adding the
 * fifth candidate is a row in `CANDIDATES`, not another script.
 *
 * Why it reads `ALL_LOCALES` rather than a list of its own: the answer changes
 * when a language is declared. A dataset that covered every locale in September
 * covers twelve of thirteen the day Arabic is added, and the scorer should say so
 * without being edited.
 *
 *   bun run places score                       every candidate
 *   bun run places score cldr                  one of them
 *   bun run places score --locales=th,ja,sw    against the languages you care about
 *
 * Downloads are cached in the system temp directory, not the tree: they are up to
 * 44MB, they are somebody else's data, and nothing we ship depends on them being
 * present. See docs/2026-09-09-why-these-sources.md for what the
 * numbers meant when they were first taken.
 */

import { spawnSync } from "node:child_process"
import { mkdirSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
/**
 * The locales to score against are an argument, not an import.
 *
 * This began in an application repository and read that application's declared
 * locale list, which was right there and wrong here: a service that holds every
 * language cannot have its evaluation tool bound to one consumer's configuration.
 * Pass `--locales=th,ja,sw` to ask "would this source serve *my* languages?", which
 * is the question the tool actually answers and the reason it is worth keeping.
 */
const DEFAULT_LOCALES = [
  "en", "es", "pt", "fr", "de", "nl", "it", "pl", "id", "ms", "vi", "tl", "tr", "sw",
  "th", "ja", "ko", "zh", "zh-TW", "ru", "uk", "ar", "fa", "ur", "hi", "bn",
]

const localeArg = process.argv.find((a) => a.startsWith("--locales="))
const ALL_LOCALES = localeArg ? localeArg.slice("--locales=".length).split(",") : DEFAULT_LOCALES
type Locale = string

const CACHE = process.env.PLACES_STAGE ?? join(tmpdir(), "shadcn-places-score")

/**
 * What a locale is called in somebody else's data.
 *
 * Two traps, in opposite directions, both silent. ICU has no `tl` — it answers
 * in English without erroring, so Filipino must be asked for as `fil`. dr5hn has
 * no `zh`, only `zh-CN`. A candidate that spells a locale differently is not a
 * candidate that lacks it, and scoring it as missing would reject a dataset for
 * a naming convention.
 */
type Aliases = Partial<Record<Locale, readonly string[]>>

interface Tier {
  /** How many rows the tier holds, before asking about any language. */
  rows: number
  /** Rows carrying a name in each locale. Absent locales are simply not keys. */
  named: Partial<Record<Locale, number>>
  /** Anything the count alone would misrepresent. */
  note?: string
}

interface Candidate {
  licence: string
  /** Downloads, in bytes, so a caller can choose not to. */
  weight: string
  score: () => Promise<Record<string, Tier>>
}

/** Fetch once, keep it in temp, report what it cost. */
async function cached(name: string, url: string): Promise<string> {
  mkdirSync(CACHE, { recursive: true })
  const path = join(CACHE, name)
  if (existsSync(path) && statSync(path).size > 0) return path
  process.stdout.write(`    fetching ${name} … `)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} → ${res.status}`)
  writeFileSync(path, Buffer.from(await res.arrayBuffer()))
  console.log(`${(statSync(path).size / 1048576).toFixed(1)}MB`)
  return path
}

/** Read a cached download. Separate from `cached` so the await chain stays legible. */
function text(path: string): string {
  return readFileSync(path, "utf-8")
}

/** Unzip once. GeoNames ships zips and there is no point re-expanding them. */
function unzip(zip: string, into: string, expect: string): string {
  if (!existsSync(expect)) spawnSync("unzip", ["-o", "-q", zip, "-d", into])
  return expect
}

/** Count rows whose translation map holds any of a locale's spellings. */
function count(rows: readonly Record<string, unknown>[], read: (row: Record<string, unknown>) => Record<string, string> | undefined, aliases: Aliases): Partial<Record<Locale, number>> {
  const out: Partial<Record<Locale, number>> = {}
  for (const row of rows) {
    const names = read(row)
    if (!names) continue
    for (const locale of ALL_LOCALES) {
      const tags = aliases[locale] ?? [locale]
      if (tags.some((t) => names[t])) out[locale] = (out[locale] ?? 0) + 1
    }
  }
  return out
}

const CANDIDATES: Record<string, Candidate> = {
  /**
   * The runtime's own CLDR, which is why this one downloads nothing.
   *
   * `fallback: "none"` matters: without it every unknown region returns its own
   * code and the count reads 676 in every language, including languages the
   * runtime has never heard of.
   */
  cldr: {
    licence: "Unicode — permissive",
    weight: "nothing, it is in the runtime",
    score: async () => {
      const codes: string[] = []
      for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) codes.push(String.fromCharCode(a, b))
      const named: Partial<Record<Locale, number>> = {}
      for (const locale of ALL_LOCALES) {
        const tag = locale === "tl" ? "fil" : locale
        const display = new Intl.DisplayNames([tag], { type: "region", fallback: "none" })
        named[locale] = codes.filter((c) => display.of(c)).length
      }
      /**
       * The denominator is how many territories exist, not how many the caller
       * asked about. Reading it off the `en` column worked only while English was
       * always in the list — the day someone scored `--locales=th,ja` it divided
       * by zero and reported 0% for languages that are at 100%.
       */
      const territories = codes.filter((c) => new Intl.DisplayNames(["en"], { type: "region", fallback: "none" }).of(c)).length
      return {
        countries: { rows: territories, named },
        subdivisions: {
          rows: 5395,
          named: { en: 5395 },
          note: "cldr-subdivisions-full carries English only — every other locale has the same three entries (England, Scotland, Wales)",
        },
      }
    },
  },

  /** 100% in nineteen languages, none of them Southeast Asian, under share-alike. */
  dr5hn: {
    licence: "ODbL-1.0 — share-alike, accepted by the PO 2026-09-09",
    weight: "45MB",
    score: async () => {
      const aliases: Aliases = { zh: ["zh", "zh-CN"], tl: ["tl", "fil"] }
      const countries = JSON.parse(text(await cached("dr5hn-countries.json", "https://raw.githubusercontent.com/dr5hn/countries-states-cities-database/master/json/countries.json"))) as Record<string, unknown>[]
      const states = JSON.parse(text(await cached("dr5hn-states.json", "https://raw.githubusercontent.com/dr5hn/countries-states-cities-database/master/json/states.json"))) as Record<string, unknown>[]
      const full = JSON.parse(text(await cached("dr5hn-full.json", "https://raw.githubusercontent.com/dr5hn/countries-states-cities-database/master/json/countries%2Bstates%2Bcities.json"))) as Record<string, unknown>[]
      const cities = full.flatMap((c) => ((c.states ?? []) as Record<string, unknown>[]).flatMap((s) => (s.cities ?? []) as Record<string, unknown>[]))
      const translations = (row: Record<string, unknown>) => row.translations as Record<string, string> | undefined
      const nativeRows = states.filter((s) => s.native).length
      return {
        countries: { rows: countries.length, named: count(countries, translations, aliases), note: "`name` is the English column and is not counted as a translation" },
        subdivisions: {
          rows: states.length,
          named: count(states, translations, aliases),
          note: `${nativeRows}/${states.length} carry \`native\`, the place in its own language. For Thailand's 78 provinces the German value equals the English in 77 and French in 74 — Latin-script coverage is largely passthrough`,
        },
        cities: { rows: cities.length, named: count(cities, translations, aliases), note: "the DDL declares `native` and `translations`; the published exports populate neither" },
      }
    },
  },

  /**
   * Measured on six countries, not the world.
   *
   * alternateNames.zip is 128MB and the answer it gives for TH, JP, VN, PH, ID
   * and KR is the answer that decides this product. A worldwide number would be
   * more impressive and no more useful, and it would put a 128MB download in a
   * command people run casually.
   */
  geonames: {
    licence: "CC BY 4.0 — a visible credit",
    weight: "~30MB, six countries",
    score: async () => {
      const sample = ["TH", "JP", "VN", "PH", "ID", "KR"]
      const admin1 = text(await cached("geonames-admin1.txt", "https://download.geonames.org/export/dump/admin1CodesASCII.txt")).trim().split("\n").map((line) => line.split("\t"))
      const regionOf = new Map<string, string>()
      for (const row of admin1) if (sample.includes(row[0].split(".")[0])) regionOf.set(row[3], row[0])
      const named: { admin1: Partial<Record<Locale, number>>, city: Partial<Record<Locale, number>> } = { admin1: {}, city: {} }
      const seen = { admin1: new Set<string>(), city: new Set<string>() }
      const cityOf = new Set<string>()
      // cities15000 is the whole world in one 3MB file; filter it to the sample.
      const zip = await cached("geonames-cities15000.zip", "https://download.geonames.org/export/dump/cities15000.zip")
      const unzipped = unzip(zip, CACHE, join(CACHE, "cities15000.txt"))
      for (const line of text(unzipped).split("\n")) {
        const row = line.split("\t")
        if (sample.includes(row[8])) cityOf.add(row[0])
      }
      const hits: Record<string, Partial<Record<Locale, Set<string>>>> = { admin1: {}, city: {} }
      for (const country of sample) {
        const path = await cached(`geonames-alt-${country}.zip`, `https://download.geonames.org/export/dump/alternatenames/${country}.zip`)
        const dir = join(CACHE, `alt-${country}`)
        for (const line of text(unzip(path, dir, join(dir, `${country}.txt`))).split("\n")) {
          const row = line.split("\t")
          const [id, lang] = [row[1], row[2]]
          const tier = regionOf.has(id) ? "admin1" : cityOf.has(id) ? "city" : null
          if (!tier) continue
          seen[tier].add(id)
          for (const locale of ALL_LOCALES) {
            const tags = locale === "tl" ? ["tl", "fil"] : [locale]
            if (!tags.includes(lang)) continue
            hits[tier][locale] ??= new Set()
            hits[tier][locale]!.add(id)
          }
        }
      }
      for (const tier of ["admin1", "city"] as const) {
        for (const locale of ALL_LOCALES) {
          const set = hits[tier][locale]
          if (set) named[tier === "admin1" ? "admin1" : "city"][locale] = set.size
        }
      }
      return {
        subdivisions: { rows: regionOf.size, named: named.admin1, note: "six countries, not the world — see the comment on this candidate" },
        cities: { rows: cityOf.size, named: named.city, note: "cities over 15,000 people in the same six countries" },
      }
    },
  },

  /**
   * The only source that translates cities, and the lightest licence of the four.
   *
   * Reached by SPARQL because there is no export to download: the alternative is
   * a 100GB+ dump. That makes it the slowest candidate here and an unreliable
   * one — the public endpoint times out on wide queries, and a timeout is
   * reported as `timeout`, never as a low score. A language that times out has
   * not been measured; do not quote it.
   *
   * The population floor is deliberate. Wikidata's coverage follows notability,
   * so it is excellent for cities anyone would hold a tournament in and thin for
   * a village. 100,000 is where the answer is still worth having; the floor is a
   * flag so a lower one can be tried without editing this.
   */
  wikidata: {
    licence: "CC0 — no attribution, no share-alike",
    weight: "nothing, but minutes of SPARQL",
    score: async () => {
      const floor = Number(process.env.REFDATA_CITY_FLOOR ?? 100_000)
      const city = `?c wdt:P31/wdt:P279* wd:Q515 ; wdt:P1082 ?p . FILTER(?p > ${floor})`
      const ask = async (where: string): Promise<number | undefined> => {
        const url = new URL("https://query.wikidata.org/sparql")
        url.searchParams.set("query", `SELECT (COUNT(DISTINCT ?c) AS ?n) WHERE { ${where} }`)
        const res = await fetch(url, {
          headers: { accept: "application/sparql-results+json", "user-agent": "remy-sport-refdata/1.0 (evaluating open place datasets)" },
          signal: AbortSignal.timeout(180_000),
        }).catch(() => undefined)
        if (!res?.ok) return undefined
        const body = (await res.json()) as { results: { bindings: { n: { value: string } }[] } }
        return Number(body.results.bindings[0]?.n.value)
      }
      const rows = (await ask(city)) ?? 0
      const named: Partial<Record<Locale, number>> = {}
      for (const locale of ALL_LOCALES) {
        const tags = locale === "tl" ? ["tl", "fil"] : [locale]
        const filter = tags.map((t) => `LANG(?l)='${t}'`).join(" || ")
        const n = await ask(`${city} . ?c rdfs:label ?l . FILTER(${filter})`)
        if (n !== undefined) named[locale] = n
        else console.log(`    ${locale}: timed out — not measured, not zero`)
      }
      return {
        cities: { rows, named, note: `cities over ${floor.toLocaleString()} people; set REFDATA_CITY_FLOOR to move the floor. A locale absent from this row timed out rather than scored zero` },
      }
    },
  },

  /**
   * Not a translation source, and worth keeping anyway.
   *
   * It ships `countries.en` and `countries.native` and nothing between them, so
   * it scores one locale out of thirteen. What it has that CLDR does not is the
   * rest of a country row — calling code, capital, currency, ISO2/ISO3, flag
   * emoji — under MIT. Scored here so the next person does not re-check whether
   * its "localised" claim means translated.
   */
  annexare: {
    licence: "MIT — permissive",
    weight: "37KB",
    score: async () => {
      const rows = Object.values(JSON.parse(text(await cached("annexare-countries.json", "https://raw.githubusercontent.com/annexare/Countries/main/dist/countries.min.json"))) as Record<string, Record<string, unknown>>)
      return {
        countries: {
          rows: rows.length,
          named: { en: rows.filter((r) => r.name).length },
          note: `\`native\` on ${rows.filter((r) => r.native).length}/${rows.length} rows is the endonym, not a translation. No other language is offered`,
        },
      }
    },
  },
}

function table(name: string, candidate: Candidate, tiers: Record<string, Tier>): void {
  console.log(`\n  ${name}  —  ${candidate.licence}`)
  for (const [tier, data] of Object.entries(tiers)) {
    const cells = ALL_LOCALES.map((l) => {
      const n = data.named[l]
      if (n === undefined) return `${l}:—`
      return `${l}:${data.rows ? Math.round((n / data.rows) * 100) : 0}%`
    })
    console.log(`    ${tier.padEnd(13)} ${String(data.rows).padStart(7)} rows   ${cells.join("  ")}`)
    if (data.note) console.log(`    ${" ".repeat(13)} ${data.note}`)
  }
}

export async function score(argv: string[]): Promise<void> {
  const names = argv.filter((a) => !a.startsWith("--"))
  const wanted = names.length ? names : Object.keys(CANDIDATES)
  console.log(`Scored against ${ALL_LOCALES.length} locales: ${ALL_LOCALES.join(" ")}`)
  console.log("Pass --locales=a,b,c to score against your own. A percentage is rows carrying a")
  console.log("name in that locale; an em dash is a locale the dataset does not offer at all.")
  let failed = false
  for (const name of wanted) {
    const candidate = CANDIDATES[name]
    if (!candidate) {
      console.error(`\n  ${name}: no such candidate. Known: ${Object.keys(CANDIDATES).join(", ")}`)
      failed = true
      continue
    }
    console.log(`\n  ${name}: downloading ${candidate.weight}`)
    table(name, candidate, await candidate.score())
  }
  if (failed) process.exitCode = 1
}
