/**
 * Where the data comes from, and what each source costs to use.
 *
 * One table rather than URLs scattered through the ETL, because the licence is
 * not metadata here — it is the reason this repository is public and the reason
 * the data and the code carry different terms. A source added without its licence
 * beside it is how an obligation gets missed.
 *
 * `weight` is what it costs to stage. It is here so that `places stage` can say
 * what it is about to download before it downloads it, on a laptop that may not
 * want 1.2GB today.
 */

export type Licence = "Unicode" | "CC BY 4.0" | "ODbL-1.0" | "CC0"

/** How a name was arrived at. Precedence is defined by KIND_RANK below. */
export type Kind = "translated" | "native" | "romanised" | "transliterated"

export interface Source {
  id: string
  licence: Licence
  /** Approximate staged size, for the warning `stage` prints. */
  weight: string
  /** Absent for Wikidata, which is queried rather than downloaded. */
  url?: string
  /** Why it is here, and what it is NOT good for. */
  note: string
  /**
   * Share-alike sources oblige us to publish what we derive. Marked so the repo
   * check can assert the derived rows are actually committed, rather than the
   * ETL being published while the database it produces is not.
   */
  shareAlike?: true
}

export const SOURCES: readonly Source[] = [
  {
    id: "cldr",
    licence: "Unicode",
    weight: "nothing — it is in the runtime",
    note: "Country names in every locale ICU carries, via Intl.DisplayNames. Complete, and stops at country level: CLDR's subdivision data is English-only, three entries in every other locale.",
  },
  {
    id: "geonames-cities",
    licence: "CC BY 4.0",
    weight: "3MB",
    url: "https://download.geonames.org/export/dump/cities15000.zip",
    note: "The city inventory: which places exist, their romanised pivot, coordinates, population. Not a translation source — cross-language coverage collapses below 100k people.",
  },
  {
    id: "geonames-admin1",
    licence: "CC BY 4.0",
    weight: "150KB",
    url: "https://download.geonames.org/export/dump/admin1CodesASCII.txt",
    note: "3,865 first-level subdivisions worldwide, English/ASCII.",
  },
  {
    id: "geonames-alternates",
    licence: "CC BY 4.0",
    weight: "193MB zipped, ~900MB expanded",
    url: "https://download.geonames.org/export/dump/alternateNames.zip",
    note: "Every language in one file, which is why extraction keeps them all: filtering would be extra work, not less. Also carries pseudo-languages — `link`, `unlc`, `wkdt` — which are not languages and must be excluded from counts. `wkdt` is the Wikidata ID, a second join key.",
  },
  {
    id: "dr5hn",
    licence: "ODbL-1.0",
    shareAlike: true,
    weight: "44MB",
    url: "https://raw.githubusercontent.com/dr5hn/countries-states-cities-database/master/json/states.json",
    note:
      "5,308 subdivisions with translations in 19 languages at 100%, plus `native` at 100%. The best subdivision source measured. Its cities carry no translations at all despite the columns existing. " +
      "Its translations are machine-produced and occasionally translate a place name as the common noun it collides with: Brazil's state of Acre is `エーカー` in Japanese and `فدان` in Arabic — both the unit of area. California and England are correct in every language checked, so this is a tail rather than a pattern, " +
      "but it is why `kind: translated` here means 'a source called this a translation' and never 'a human has read it'. Four subdivision ids also appear twice (French overseas territories); the merge keeps the first and counts the rest.",
  },
  {
    id: "wikidata",
    licence: "CC0",
    weight: "nothing to download, minutes of SPARQL",
    note: "The only real cross-language city source: 84% ja and 89% ru for cities of 15k-100k, where GeoNames manages 7% and 20%. Joined on P1566, the GeoNames ID. Queried per language, so it is the one source with a language policy of its own.",
  },
]

/**
 * Which name wins when several sources name the same place in the same language.
 *
 * A rule rather than a judgement, so that a re-run is deterministic and so that a
 * transliteration added later is replaced automatically the day a real name
 * appears upstream — rather than someone having to notice.
 */
export const KIND_RANK: Record<Kind, number> = {
  translated: 3,
  native: 2,
  transliterated: 1,
  romanised: 0,
}

/**
 * Tags GeoNames puts in the language column that are not languages.
 *
 * Counting these as languages makes `link` and `unlc` look like two of the most
 * widely spoken on earth. `wkdt` is kept out of names for the same reason and
 * read separately, as a join key.
 */
export const NOT_LANGUAGES = new Set(["link", "unlc", "wkdt", "iata", "icao", "faac", "abbr", "post", "phon"])

export const byId = (id: string): Source => {
  const found = SOURCES.find((s) => s.id === id)
  if (!found) throw new Error(`unknown source: ${id}. Known: ${SOURCES.map((s) => s.id).join(", ")}`)
  return found
}
