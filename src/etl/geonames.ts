/**
 * What a GeoNames row means, defined once for both runtimes.
 *
 * The CLI reads these files from a directory on a laptop; the Workflow streams
 * them out of a zip over HTTP. Those are two transports for one format, and the
 * moment each owns its own column indices they drift — the shape of every bug
 * this repository has recorded. `alternateNames.txt` has nine columns and only
 * four matter; getting `$3` and `$4` the wrong way round yields language codes
 * as names and fails nowhere.
 *
 * So the transports differ and the parsing does not.
 */

import { isLanguageTag } from "../../scripts/lib/sources.ts"

/** A name as a source offered it, before the merge decides anything. */
export interface RawName {
  locale: string
  value: string
  source: string
  kind: "translated" | "native" | "romanised" | "transliterated" | "override"
}

/** A place as extracted, before merge. Matches `.build/*.ndjson`. */
export interface RawPlace {
  id: string
  type: "country" | "subdivision" | "city"
  pivot: string
  country?: string
  parent?: string
  lat?: number
  lon?: number
  population?: number
  wikidata?: string
  names: RawName[]
}

/**
 * Split a TSV line without allocating an array per column we ignore.
 *
 * `alternateNames.txt` is 19.1 million lines. `String.split("\t")` on each one
 * builds a nine-element array to read four of them, and at that volume the
 * difference is measurable rather than theoretical.
 */
function column(line: string, index: number): string {
  let start = 0
  for (let i = 0; i < index; i++) {
    const next = line.indexOf("\t", start)
    if (next < 0) return ""
    start = next + 1
  }
  const end = line.indexOf("\t", start)
  return end < 0 ? line.slice(start) : line.slice(start, end)
}

/**
 * One row of `alternateNames.txt`, or null if it carries nothing usable.
 *
 * `wkdt` is not a language — it is GeoNames' Wikidata id, and it is the join key
 * for the label pass. `link` and `unlc` are not languages either, and counting
 * them made two of the most widely spoken tongues on earth.
 *
 * A blank language column is 38% of the file. Those rows are almost all
 * romanisations we already hold as the pivot, and the ones that are not are
 * measured at 3,551 names across the whole city inventory — so they are dropped
 * here rather than guessed at, and the number is recorded so the decision can be
 * revisited with evidence.
 */
export function parseAlternateName(line: string): { geonameId: string; kind: "wikidata" | "name"; locale: string; value: string } | null {
  const geonameId = column(line, 1)
  if (!geonameId) return null
  const value = column(line, 3)
  if (!value) return null
  const lang = column(line, 2)
  if (lang === "wkdt") return { geonameId, kind: "wikidata", locale: "", value }
  if (!lang || !isLanguageTag(lang)) return null
  return { geonameId, kind: "name", locale: lang, value }
}

/**
 * One row of `cities5000.txt` into a place.
 *
 * The romanised ASCII form is recorded as a name in its own right rather than
 * left implicit, so `kind` can say what it is. That is the distinction the whole
 * service rests on: a Latin string is the right answer for a German reader and an
 * unreadable one for a Thai reader, and only a recorded `kind` can tell them
 * apart later.
 */
export function parseCityRow(line: string): RawPlace | null {
  const id = column(line, 0)
  const name = column(line, 1)
  if (!id || !name) return null
  const ascii = column(line, 2)
  const country = column(line, 8)
  const admin1 = column(line, 10)
  const names: RawName[] = []
  if (ascii && ascii !== name) {
    names.push({ locale: "und", value: ascii, source: "geonames", kind: "romanised" })
  }
  return {
    id: `city:${id}`,
    type: "city",
    pivot: ascii || name,
    country,
    parent: admin1 ? `subdivision:${country}-${admin1}` : `country:${country}`,
    lat: Number(column(line, 4)) || undefined,
    lon: Number(column(line, 5)) || undefined,
    population: Number(column(line, 14)) || undefined,
    names,
  }
}

/**
 * Turn a byte stream into lines, without holding the file.
 *
 * The failure this replaces is recorded in the first-build notes: a streaming
 * parser that rescanned each chunk from index 0, corrupted its own in-string
 * state, parsed 56 of 5,308 rows and reported success. The fix there and the rule
 * here are the same — carry the remainder forward and never re-read what has been
 * consumed.
 */
export async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let rest = ""
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const text = rest + decoder.decode(value, { stream: true })
      let start = 0
      for (;;) {
        const nl = text.indexOf("\n", start)
        if (nl < 0) break
        const line = text.charCodeAt(nl - 1) === 13 ? text.slice(start, nl - 1) : text.slice(start, nl)
        if (line) yield line
        start = nl + 1
      }
      rest = text.slice(start)
    }
    if (rest.trim()) yield rest
  } finally {
    // Releasing matters: an abandoned reader keeps the underlying fetch alive,
    // and a Workflow step that takes a slice and stops is the normal case here.
    reader.releaseLock()
  }
}
