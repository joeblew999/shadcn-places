/**
 * Invariants about the data, not the code.
 *
 * These are the failures that pass every type check, every unit test and every
 * deploy, and are then obvious to the first human who opens the dropdown. The
 * country list had Germany in it twice — once as `DE` and once as `DD`, East
 * Germany — along with Serbia three times, the United Nations, the Euro zone and
 * two pseudo-locales used for testing. Every one of those was a valid region code
 * that CLDR was willing to name.
 *
 * A JSON response of 300 objects hides that completely. A `<select>` does not.
 * So the properties a person would notice at a glance are asserted here, where
 * they fail before anyone has to look.
 *
 * The data is read from the built artefacts, so these run after `places extract`
 * and are skipped when nothing is built — a fresh clone should not fail for
 * having no `.build/`.
 */

import { existsSync, readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { resolve } from "node:path"
import { describe, it, expect } from "vitest"
import { records } from "../../scripts/lib/ndjson.ts"
import type { MergedPlace } from "../../scripts/places/merge.ts"

const ROOT = resolve(import.meta.dirname, "../..")
const built = (tier: string) => resolve(ROOT, `.build/${tier}.merged.ndjson`)
const have = (tier: string) => existsSync(built(tier))

const load = async (tier: string): Promise<MergedPlace[]> => {
  const out: MergedPlace[] = []
  for await (const p of records<MergedPlace>(built(tier))) out.push(p)
  return out
}

describe.skipIf(!have("countries"))("countries", () => {
  it("names no country twice", async () => {
    const places = await load("countries")
    const byName = new Map<string, string[]>()
    for (const p of places) byName.set(p.pivot, [...(byName.get(p.pivot) ?? []), p.id])
    const duplicated = [...byName].filter(([, ids]) => ids.length > 1)
    expect(
      duplicated.map(([name, ids]) => `${name}: ${ids.join(", ")}`),
      "two codes produced the same country — a deprecated alias has crept back in",
    ).toEqual([])
  })

  it("contains no organisations, groupings or test regions", async () => {
    const places = await load("countries")
    const names = new Set(places.map((p) => p.pivot))
    // Each of these was in the list at some point and each is a different kind of
    // wrong: an organisation, a currency zone, a grouping, an unknown, a test.
    for (const wrong of ["European Union", "Eurozone", "United Nations", "Outlying Oceania", "Unknown Region"]) {
      expect(names.has(wrong), `"${wrong}" is not somewhere a person lives`).toBe(false)
    }
    for (const p of places) {
      expect(p.pivot, "a pseudo-locale leaked into the country list").not.toMatch(/^Pseudo/i)
    }
  })

  it("has a plausible number of them", async () => {
    // 249 assigned ISO 3166-1 codes, plus CLDR's extras like Ascension and the
    // Canary Islands. A wide band on purpose: this catches a filter that removed
    // half the world, not a disagreement about whether Kosovo counts.
    const places = await load("countries")
    expect(places.length).toBeGreaterThan(230)
    expect(places.length).toBeLessThan(300)
  })
})

describe.skipIf(!have("countries") || !have("subdivisions"))("the hierarchy holds", () => {
  it("every subdivision points at a country that exists", async () => {
    const countries = new Set((await load("countries")).map((p) => p.id))
    const orphans: string[] = []
    for (const s of await load("subdivisions")) {
      if (s.parent && !countries.has(s.parent)) orphans.push(`${s.id} → ${s.parent}`)
    }
    // A subdivision whose country is missing cannot be reached by the cascade, so
    // it is invisible in the picker while still counting in every total.
    expect(orphans.slice(0, 10), `${orphans.length} subdivisions have no country`).toEqual([])
  })

  it("no place is its own parent", async () => {
    for (const tier of ["countries", "subdivisions"]) {
      for (const p of await load(tier)) expect(p.parent).not.toBe(p.id)
    }
  })
})

describe.skipIf(!have("countries"))("names are honest", () => {
  it("never records a name identical to the pivot as a translation", async () => {
    const bad: string[] = []
    for (const p of await load("countries")) {
      for (const n of p.names) {
        if (n.value === p.pivot && n.kind === "translated") bad.push(`${p.id} ${n.locale}`)
      }
    }
    // The whole point of `kind`. If this ever passes silently, coverage numbers
    // become marketing.
    expect(bad.slice(0, 10), `${bad.length} names claim to be translations of themselves`).toEqual([])
  })

  it("gives every place a pivot to fall back to", async () => {
    for (const tier of ["countries", "subdivisions"]) {
      for (const p of await load(tier)) {
        expect(p.pivot?.trim(), `${p.id} has no pivot — a caller asking for a rare locale would get nothing`).toBeTruthy()
      }
    }
  })
})

describe.skipIf(!have("countries"))("the published database matches what was built", () => {
  /**
   * `data/` drifted once already: the country filter removed 23 deprecated
   * aliases, the service was reloaded, and the gzipped artefact stayed at 280
   * rows for an hour. Nothing failed. The repo claimed to publish the database
   * it serves and published a previous one — which is a licence problem wearing
   * the costume of a stale file.
   *
   * Compared by row count rather than by hash: the build is not byte-reproducible
   * (CLDR moves with the runtime's ICU) and a hash check would fail for reasons
   * nobody could act on. A count catches the failure that actually happens, which
   * is forgetting to re-export.
   */
  for (const tier of ["countries", "subdivisions", "cities"] as const) {
    it.skipIf(!have(tier))(`${tier} is exported at the built size`, async () => {
      const builtRows = (await load(tier)).length
      const published = gunzipSync(readFileSync(resolve(ROOT, `data/${tier}.ndjson.gz`)))
        .toString("utf8").trimEnd().split("\n").length
      expect(
        published,
        `data/${tier}.ndjson.gz has ${published} rows but the build has ${builtRows}. ` +
          `Re-export: gzip -9 -c .build/${tier}.merged.ndjson > data/${tier}.ndjson.gz`,
      ).toBe(builtRows)
    })
  }
})
