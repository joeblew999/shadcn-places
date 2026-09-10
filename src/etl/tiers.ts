/**
 * Countries and subdivisions, defined once for both runtimes.
 *
 * The CLI reads dr5hn and GeoNames off a disk; the Workflow fetches them over
 * HTTP. Two transports for one format — and the moment each owns its own column
 * indices and its own locale list they drift, which is the shape of every bug
 * this repository has recorded.
 *
 * `src/etl/geonames.ts` does the same job for cities. This is the other two tiers.
 */

import { isLanguageTag } from "../../scripts/lib/sources.ts"
import type { RawPlace, RawName } from "./geonames.ts"

/**
 * Region codes ICU will happily name that are not countries anyone picks from.
 *
 * Enumerating every two-letter code and keeping whatever CLDR names produces a
 * list with Germany in it twice — once as DE and once as DD, East Germany — plus
 * Serbia three times, the Euro zone, the United Nations, and two pseudo-locales
 * used for testing that render as 疑似アクセント. It looked fine in a JSON
 * response and was obvious the moment a human opened the dropdown.
 *
 * Two groups, and they are excluded for different reasons:
 *
 *   Deprecated ISO codes still carried by CLDR for historical data — every one of
 *   these is a synonym for a country already in the list, so keeping them is a
 *   duplicate rather than a country.
 *
 *   Groupings and non-countries — organisations, currency unions, an unknown
 *   region, and the two pseudo-locales.
 *
 * `tests/repo/data.test.ts` holds the invariant this exists to produce: no two
 * countries share a name. A list that grows a duplicate again fails there rather
 * than in somebody's dropdown.
 */
export const NOT_A_COUNTRY = new Set([
  // Deprecated ISO 3166-1 codes: synonyms for a country already present.
  "AN","BU","CS","CT","DD","DY","FQ","FX","HV","JT","MI","NH","NQ","NT","PC","PU",
  "PZ","RH","SU","TP","UK","VD","WK","YD","YU","ZR",
  // Groupings, organisations and test regions — never a place a person is in.
  "EU","EZ","UN","QO","ZZ","XA","XB",
])

/**
 * The locales to snapshot countries in.
 *
 * ICU carries hundreds and `Intl` exposes no list of them, so this enumerates the
 * CLDR modern coverage set. It is the one place a language list exists in this
 * service, it is about what CLDR *has* rather than what any consumer wants, and a
 * locale absent here still resolves at request time from the same ICU.
 */
export const CLDR_LOCALES = [
  "af","am","ar","az","be","bg","bn","bs","ca","cs","cy","da","de","el","en","es","et","eu","fa","fi","fil",
  "fr","ga","gl","gu","he","hi","hr","hu","hy","id","is","it","ja","ka","kk","km","kn","ko","ky","lo","lt",
  "lv","mk","ml","mn","mr","ms","my","nb","ne","nl","pa","pl","ps","pt","ro","ru","si","sk","sl","sq","sr",
  "sv","sw","ta","te","th","tr","uk","ur","uz","vi","zh","zh-Hant","zu",
]


export function* countryPlaces(): Generator<RawPlace> {
  const codes: string[] = []
  for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) codes.push(String.fromCharCode(a, b))
  const english = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" })
  for (const code of codes) {
    if (NOT_A_COUNTRY.has(code)) continue
    const pivot = english.of(code)
    if (!pivot) continue
    const names: RawName[] = []
    for (const locale of CLDR_LOCALES) {
      const tag = locale === "tl" ? "fil" : locale
      const value = new Intl.DisplayNames([tag], { type: "region", fallback: "none" }).of(code)
      if (!value) continue
      const resolved = new Intl.DisplayNames([tag], { type: "region" }).resolvedOptions().locale
      // If ICU fell back to another language, the string is that language's, not
      // this one's. Recording it as `locale` would be a lie the size of a country.
      if (!resolved.toLowerCase().startsWith(tag.toLowerCase().split("-")[0])) continue
      names.push({ locale, value, source: "cldr", kind: "translated" })
    }
    yield { id: `country:${code}`, type: "country", pivot, names }
  }
}


/**
 * One dr5hn state row into a subdivision.
 *
 * dr5hn ships nineteen languages at 100% and a `native` endonym, which is why it
 * is the subdivision source. Its translations are machine-produced and
 * occasionally render a place name as the common noun it collides with — Brazil's
 * state of Acre is `エーカー` in Japanese and `فدان` in Arabic, both the unit of
 * area — so `kind: "translated"` here means *a source called this a translation*
 * and never *a human has read it*.
 */
export function parseSubdivisionRow(row: Record<string, unknown>): RawPlace | null {
  const code = String(row.iso3166_2 ?? `${row.country_code}-${row.iso2}`)
  const pivot = String(row.name ?? "")
  if (!pivot || !code || code.includes("undefined")) return null

  const names: RawName[] = []
  const native = row.native as string | undefined
  // `und` — the endonym without a language tag. dr5hn does not say which language
  // it is in, and guessing from the country would be wrong for every bilingual one.
  if (native && native !== pivot) names.push({ locale: "und", value: native, source: "dr5hn", kind: "native" })

  for (const [tag, value] of Object.entries((row.translations ?? {}) as Record<string, string>)) {
    if (!value) continue
    /**
     * Kept as dr5hn spells them — `zh-CN`, `pt-BR`.
     *
     * A consumer asking for `zh` reaches them through locale negotiation, and the
     * merge canonicalises the tag anyway. Rewriting somebody else's tags at read
     * time is how a wrong mapping becomes silent.
     */
    names.push({ locale: tag, value, source: "dr5hn", kind: value === pivot ? "romanised" : "translated" })
  }

  return {
    id: `subdivision:${code}`,
    type: "subdivision",
    pivot,
    country: String(row.country_code ?? ""),
    parent: `country:${row.country_code}`,
    lat: Number(row.latitude) || undefined,
    lon: Number(row.longitude) || undefined,
    wikidata: (row.wikiDataId as string) || undefined,
    names,
  }
}

/**
 * Names off an OpenStreetMap admin relation, keyed by the code it carries.
 *
 * The join is exact and needs no matching: OSM's `ISO3166-2` tag **is** our
 * subdivision id — `BR-SP` either way. No coordinates, no name similarity, no
 * threshold to tune.
 *
 * It earns its place by covering what dr5hn does not. dr5hn has nineteen
 * languages and none of them are Thai, Vietnamese, Indonesian, Swahili, Hebrew,
 * Greek or Bengali; OSM has all of those.
 */
export function osmSubdivision(element: { tags?: Record<string, string> }): { id: string; names: RawName[] } | null {
  const code = element.tags?.["ISO3166-2"]
  if (!code) return null
  const names: RawName[] = []
  for (const [tagKey, value] of Object.entries(element.tags ?? {})) {
    if (!tagKey.startsWith("name:") || !value) continue
    const locale = tagKey.slice("name:".length)
    // `name:prefix:xx` and similar are qualified variants, not plain names.
    if (locale.includes(":") || !isLanguageTag(locale)) continue
    names.push({ locale, value, source: "osm", kind: "translated" })
  }
  return names.length ? { id: `subdivision:${code}`, names } : null
}

/**
 * `TH.40` → `subdivision:TH-40`, from one row of GeoNames' admin1 codes.
 *
 * The bridge that lets the alternate-names pass reach subdivisions at all: that
 * file is keyed by GeoNames id and ours are keyed by ISO 3166-2, and this row is
 * the only place the two are written down together.
 */
export function parseAdmin1Row(line: string): { geonameId: string; id: string } | null {
  const [code, , , geonameId] = line.split("\t")
  if (!code || !geonameId) return null
  return { geonameId, id: `subdivision:${code.replace(".", "-")}` }
}
