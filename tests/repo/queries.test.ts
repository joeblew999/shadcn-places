/**
 * No query may scan the world, and no name may lie about what it is.
 *
 * Two rules that are cheap to state, expensive to discover, and impossible to keep
 * by intention alone once more than one person is working here.
 *
 * The first is about money: D1 bills rows *scanned*, so a city search without a
 * parent filter reads 152,970 rows on every keystroke, and on a free plan the
 * queries stop rather than slow down. The contract is where this is prevented —
 * a city search that cannot be expressed without a country cannot be written
 * accidentally — so the check reads the contract.
 *
 * The second is about honesty: a name identical to the romanised pivot is a
 * fallback, whatever the source called it. The repository this grew out of had
 * 31% of its non-Latin-script name cells holding the English string while every
 * completeness check passed, because presence was all anything measured.
 */

import { describe, it, expect } from "vitest"
import { contract } from "../../src/api/contract.ts"
import { resolve } from "../../scripts/places/merge.ts"
import { KIND_RANK } from "../../scripts/lib/sources.ts"
import type { Place } from "../../scripts/places/extract.ts"

describe("a query cannot scan the world", () => {
  it("city search requires a country", () => {
    const shape = (contract.cities.search as unknown as { "~orpc": { inputSchema: { shape: Record<string, { isOptional(): boolean }> } } })["~orpc"]
    const country = shape.inputSchema.shape.country
    expect(country, "cities.search has no `country` input").toBeDefined()
    expect(country.isOptional(), "cities.search accepts no country — that is a full table scan").toBe(false)
  })

  it("city search is bounded", () => {
    // An unbounded limit is the other way to read the whole table: ask for it all
    // one page at a time and nothing says no.
    const shape = (contract.cities.search as unknown as { "~orpc": { inputSchema: { shape: Record<string, unknown> } } })["~orpc"]
    expect(shape.inputSchema.shape.limit, "cities.search has no limit").toBeDefined()
  })

  it("subdivision listing requires a country", () => {
    const shape = (contract.subdivisions.list as unknown as { "~orpc": { inputSchema: { shape: Record<string, { isOptional(): boolean }> } } })["~orpc"]
    expect(shape.inputSchema.shape.country.isOptional()).toBe(false)
  })
})

describe("a name says what it is", () => {
  const place = (names: Place["names"]): Place => ({
    id: "city:1", type: "city", pivot: "Ourinhos", names,
  })

  it("demotes a value identical to the pivot, whatever its source claimed", () => {
    const [name] = resolve(place([{ locale: "th", value: "Ourinhos", source: "dr5hn", kind: "translated" }]))
    expect(name.kind, "an untranslated string was recorded as a translation").toBe("romanised")
  })

  it("keeps a genuine translation as translated", () => {
    const [name] = resolve(place([{ locale: "ru", value: "Оуриньюс", source: "wikidata", kind: "translated" }]))
    expect(name.kind).toBe("translated")
  })

  it("prefers a real translation over a romanisation for the same locale", () => {
    const names = resolve(
      place([
        { locale: "ru", value: "Ourinhos", source: "dr5hn", kind: "translated" },
        { locale: "ru", value: "Оуриньюс", source: "wikidata", kind: "translated" },
      ]),
    )
    expect(names).toHaveLength(1)
    expect(names[0].value).toBe("Оуриньюс")
    // The loser is counted, not kept: a caller does not want a list of rejected
    // spellings, but somebody debugging coverage wants to know there was a choice.
    expect(names[0].alternatives).toBe(1)
  })

  it("ranks kinds so a transliteration is replaced when a real name arrives", () => {
    expect(KIND_RANK.translated).toBeGreaterThan(KIND_RANK.transliterated)
    expect(KIND_RANK.transliterated).toBeGreaterThan(KIND_RANK.romanised)
  })

  it("keeps one name per locale", () => {
    const names = resolve(
      place([
        { locale: "ja", value: "オウリーニョス", source: "wikidata", kind: "translated" },
        { locale: "ja", value: "Ourinhos", source: "geonames", kind: "translated" },
        { locale: "de", value: "Ourinhos", source: "geonames", kind: "translated" },
      ]),
    )
    expect(names.map((n) => n.locale)).toEqual(["de", "ja"])
  })
})
