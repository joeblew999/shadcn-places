/**
 * One tag per language, and the table that decides it comes from CLDR.
 *
 * Filipino was two half-populated languages: 2,543 names under `tl`, 1,148 under
 * `fil`, and a request negotiation of `locale IN (locale, base)` that can reach
 * exactly one of them. A Filipino reader asking for `fil` was told this service
 * had 0% of their subdivisions while 446 real ones sat under `tl`.
 *
 * The first fix was twelve alias entries typed out by hand. CLDR ships five
 * hundred and agreed with eleven of them — and carries every ISO 639-2/3
 * three-letter code the hand list missed. That would have been the third
 * hand-typed language list in one file, after fifty non-Latin scripts that were
 * missing thirty-nine.
 *
 * So the table is generated, and this is what stops the generated copy going
 * stale — the failure this repository has already been caught by twice.
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, it, expect } from "vitest"
import { buildAliases } from "../../scripts/places/aliases.ts"
import { canonicalLocale } from "../../scripts/lib/sources.ts"

const ROOT = resolve(import.meta.dirname, "../..")
const committed = JSON.parse(
  readFileSync(resolve(ROOT, "src/api/locale-aliases.json"), "utf8"),
) as { cldrVersion: string; aliases: Record<string, string> }

describe("the language alias table", () => {
  it("is the one CLDR currently ships", () => {
    const fresh = buildAliases()
    expect(
      committed.aliases,
      "src/api/locale-aliases.json is stale — run `bun run places aliases`",
    ).toEqual(fresh.aliases)
    expect(committed.cldrVersion).toBe(fresh.cldrVersion)
  })

  it("is big enough to be CLDR's rather than somebody's shortlist", () => {
    // The hand-written version had twelve. If this ever drops to that order of
    // magnitude the generator has silently stopped finding the source file.
    expect(Object.keys(committed.aliases).length).toBeGreaterThan(400)
  })

  it("heals the splits that were actually in the data", () => {
    // Each of these was two half-populated languages in the deployed database.
    expect(canonicalLocale("tl")).toBe("fil")
    expect(canonicalLocale("no")).toBe("nb")
    expect(canonicalLocale("bh")).toBe("bho")
    // Script matters: `sh` is Serbo-Croatian in Latin and `sr` is Cyrillic, so
    // folding it into `sr` would hand a Cyrillic reader Latin strings.
    expect(canonicalLocale("sh")).toBe("sr-Latn")
    expect(canonicalLocale("hbs")).toBe("sr-Latn")
  })

  it("keeps `als` as Alemannic German, against CLDR", () => {
    /**
     * The one place this deliberately disagrees with the table.
     *
     * CLDR aliases `als` to `sq`, Tosk Albanian. Our values are "Kanton Jura",
     * "Wil SG", "Veyrier GE" — Wikipedia uses `als` for Alemannic German, and
     * applying CLDR's alias would file German names under Albanian, where the
     * script check would call every one of them a real translation.
     */
    expect(committed.aliases.als, "CLDR still says sq; the override is what matters").toBe("sq")
    expect(canonicalLocale("als")).toBe("gsw")
  })

  it("resolves the three-letter codes the hand-written list missed entirely", () => {
    expect(canonicalLocale("deu")).toBe("de")
    expect(canonicalLocale("fra")).toBe("fr")
    expect(canonicalLocale("zho")).toBe("zh")
    expect(canonicalLocale("gre")).toBe("el")
  })

  it("leaves region and script subtags alone", () => {
    // `pt-BR` is not `pt`; the request negotiation already falls back.
    expect(canonicalLocale("pt-BR")).toBe("pt-BR")
    expect(canonicalLocale("en")).toBe("en")
    // A base alias carries its subtags across.
    expect(canonicalLocale("tl-PH")).toBe("fil-PH")
    // An alias that already names a script replaces the whole tag rather than
    // producing `sr-Latn-Latn`.
    expect(canonicalLocale("sh-Latn")).toBe("sr-Latn")
  })

  it("is idempotent", () => {
    // The merge canonicalises on ingest and the Worker canonicalises the request.
    // If applying it twice moved a tag, those two would disagree.
    for (const tag of Object.keys(committed.aliases)) {
      const once = canonicalLocale(tag)
      expect(canonicalLocale(once), `${tag} → ${once} → ${canonicalLocale(once)}`).toBe(once)
    }
  })
})

describe("the published data uses canonical tags only", () => {
  /**
   * The check that proves the merge actually applied it.
   *
   * A canonicaliser that exists and is not called is the same as no
   * canonicaliser, and this repository has shipped that shape before — a
   * `BatchHandlerPlugin` on the server with no client batching, a coercion plugin
   * with no converters.
   */
  const { existsSync } = require("node:fs") as typeof import("node:fs")
  const path = resolve(ROOT, "data/countries.ndjson.gz")

  it.skipIf(!existsSync(path))("has no aliased locale left in it", async () => {
    const { gunzipSync } = await import("node:zlib")
    const offenders = new Map<string, string>()
    for (const line of gunzipSync(readFileSync(path)).toString("utf8").trimEnd().split("\n")) {
      if (!line) continue
      const place = JSON.parse(line) as { names: { locale: string }[] }
      for (const n of place.names) {
        const canonical = canonicalLocale(n.locale)
        if (canonical !== n.locale) offenders.set(n.locale, canonical)
      }
    }
    expect(
      [...offenders].map(([from, to]) => `${from} should be ${to}`),
      "published data still holds an aliased tag — the merge did not canonicalise it, so this " +
        "language is split in two and the API can reach only one half",
    ).toEqual([])
  })
})
