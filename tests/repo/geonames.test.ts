/**
 * What a GeoNames row means, asserted once for both runtimes.
 *
 * The CLI reads these files from a directory and the Workflow streams them out of
 * a zip over HTTP. Two transports, one format — and the moment each owns its own
 * column indices they drift. `alternateNames.txt` has nine columns and four
 * matter; swapping `$3` and `$4` files language codes as names and fails nowhere.
 */

import { describe, it, expect } from "vitest"
import { lines, parseAlternateName, parseCityRow } from "../../src/etl/geonames.ts"

const streamOf = (text: string): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(text)
  return new ReadableStream({
    start(c) {
      // Deliberately chunked mid-line: a parser that assumes chunk boundaries
      // fall on newlines is the bug that parsed 56 of 5,308 rows and reported
      // success. Splitting at 7 bytes guarantees it never does.
      for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.subarray(i, i + 7))
      c.close()
    },
  })
}

const collect = async (text: string) => {
  const out: string[] = []
  for await (const line of lines(streamOf(text))) out.push(line)
  return out
}

describe("splitting a stream into lines", () => {
  it("survives chunk boundaries inside a line", async () => {
    expect(await collect("alpha\nbeta\ngamma\n")).toEqual(["alpha", "beta", "gamma"])
  })

  it("yields a final line with no trailing newline", async () => {
    expect(await collect("only")).toEqual(["only"])
  })

  it("strips a carriage return", async () => {
    // GeoNames' iso-languagecodes.txt is CRLF. A \r left on the end becomes part
    // of the last column and every value silently gains an invisible character.
    expect(await collect("a\tb\r\nc\td\r\n")).toEqual(["a\tb", "c\td"])
  })

  it("skips blank lines rather than emitting empty rows", async () => {
    expect(await collect("a\n\n\nb\n")).toEqual(["a", "b"])
  })
})

describe("alternateNames rows", () => {
  const row = (id: string, lang: string, value: string) => `999\t${id}\t${lang}\t${value}\t\t\t\t\t`

  it("reads the id, language and value", () => {
    expect(parseAlternateName(row("1609350", "th", "กรุงเทพมหานคร"))).toEqual({
      geonameId: "1609350",
      kind: "name",
      locale: "th",
      value: "กรุงเทพมหานคร",
    })
  })

  it("treats wkdt as the Wikidata id, not a language", () => {
    // Counting it as one made `wkdt` look like a widely spoken tongue, and it is
    // the join key the whole label pass depends on.
    expect(parseAlternateName(row("1609350", "wkdt", "Q1861"))).toEqual({
      geonameId: "1609350",
      kind: "wikidata",
      locale: "",
      value: "Q1861",
    })
  })

  it("drops the pseudo-languages GeoNames puts in that column", () => {
    for (const tag of ["link", "unlc", "iata", "post"]) {
      expect(parseAlternateName(row("1", tag, "x")), tag).toBeNull()
    }
  })

  it("drops a blank language rather than guessing at it", () => {
    /**
     * 38% of the file — 7.3 million rows.
     *
     * Measured before deciding: for our inventory they are 102,927 Latin
     * romanisations we already hold as the pivot and 3,551 non-Latin names, of
     * which 36 belong to a place that has no name at all. Dropped on the
     * evidence, and the numbers are here so the decision can be revisited with
     * better ones rather than re-argued from intuition.
     */
    expect(parseAlternateName(row("1", "", "青浦"))).toBeNull()
  })

  it("drops a row with no value", () => {
    expect(parseAlternateName(row("1", "th", ""))).toBeNull()
  })
})

describe("city rows", () => {
  // id, name, ascii, alternates, lat, lon, feature class/code, country, cc2,
  // admin1..4, population
  const bangkok =
    "1609350\tBangkok\tBangkok\tBangkok,Krung Thep\t13.75398\t100.50144\tP\tPPLC\tTH\t\t40\t\t\t\t5104476"

  it("reads the columns the pipeline uses", () => {
    const place = parseCityRow(bangkok)!
    expect(place.id).toBe("city:1609350")
    expect(place.pivot).toBe("Bangkok")
    expect(place.country).toBe("TH")
    expect(place.parent).toBe("subdivision:TH-40")
    expect(place.lat).toBeCloseTo(13.75398)
    expect(place.lon).toBeCloseTo(100.50144)
    expect(place.population).toBe(5104476)
  })

  it("records the romanised form as a name when it differs", () => {
    // Recorded rather than left implicit, so `kind` can say what it is. That
    // distinction is the whole service: a Latin string is right for a German
    // reader and unreadable for a Thai one.
    const row = bangkok.replace("Bangkok\tBangkok\t", "กรุงเทพมหานคร\tBangkok\t")
    const place = parseCityRow(row)!
    expect(place.names).toEqual([
      { locale: "und", value: "Bangkok", source: "geonames", kind: "romanised" },
    ])
  })

  it("adds no romanised name when the ascii form is the name", () => {
    expect(parseCityRow(bangkok)!.names).toEqual([])
  })

  it("parents a city on its country when it has no admin1", () => {
    const orphan = bangkok.replace("\tTH\t\t40\t", "\tTH\t\t\t")
    expect(parseCityRow(orphan)!.parent).toBe("country:TH")
  })

  it("refuses a row with no id or name", () => {
    expect(parseCityRow("\t\t\t")).toBeNull()
  })
})
