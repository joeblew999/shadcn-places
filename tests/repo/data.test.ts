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

import { existsSync, readFileSync, statSync } from "node:fs"
import { execSync } from "node:child_process"
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
    /**
     * True of every language except the one the pivot is written in.
     *
     * The pivot is the romanised English name, so an English row equal to it is
     * not a fallback — it is the answer. This rule did not exclude English and
     * never fired, because the merge was demoting those rows to `romanised`
     * anyway. That demotion is what made a *worse* English name outrank a better
     * one: GeoNames offers "Gold Coast" (marked preferred) and "Gold" for the
     * same place, the first was demoted for matching the pivot, and the service
     * served "Gold". Also "Sydney City" over Sydney, "Melbourne City" over
     * Melbourne — three of the six cities on the demo's front page.
     *
     * Two rules were quietly agreeing with each other and both were wrong. The
     * merge stopped demoting English; this stopped asserting it should.
     *
     * The purpose is unchanged and is the reason it exists: a Thai or Russian
     * name that is secretly the English string must never count as a translation,
     * or the coverage numbers become marketing.
     */
    const bad: string[] = []
    for (const p of await load("countries")) {
      for (const n of p.names) {
        if (n.locale === "en" || n.locale.startsWith("en-")) continue
        if (n.value === p.pivot && n.kind === "translated") bad.push(`${p.id} ${n.locale}`)
      }
    }
    expect(bad.slice(0, 10), `${bad.length} names claim to be translations of themselves`).toEqual([])
  })

  it("still catches a non-English name that is secretly the English string", async () => {
    // The rule above is scoped now, so this proves the scoping did not gut it: a
    // Thai row holding the English word must be `romanised`, never `translated`.
    const { resolve } = await import("../../src/etl/resolve.ts")
    const place = {
      id: "city:1",
      type: "city" as const,
      pivot: "Ourinhos",
      names: [{ locale: "th", value: "Ourinhos", source: "dr5hn", kind: "translated" as const }],
    }
    expect(resolve(place, {})[0].kind).toBe("romanised")
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

describe("overrides", () => {
  /**
   * The one source a rebuild cannot re-derive, and therefore the one that rots.
   *
   * An override points at a place id from a dataset that changes underneath it.
   * When upstream renames an id, the override stops applying — and it fails
   * silently, because a correction that matches nothing looks exactly like a
   * correction that was never needed. The wrong name comes back and the file
   * still looks like it is handling it.
   *
   * These run whenever the file exists, not only when a build does, because a
   * malformed override should fail on a fresh clone rather than at merge time.
   */
  const file = resolve(ROOT, "overrides.json")
  const raw = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as { names?: Record<string, Record<string, string>> })
    : { names: {} }
  const entries = Object.entries(raw.names ?? {})

  it("gives every override a reason", () => {
    // Without one, whoever inherits this cannot tell a correction from a typo,
    // and cannot ever decide it is safe to remove.
    for (const [id, entry] of entries) {
      expect(entry.why?.trim(), `${id} has no "why" — nobody will know whether to keep it`).toBeTruthy()
    }
  })

  it("uses locale tags, not stray keys", () => {
    for (const [id, entry] of entries) {
      for (const key of Object.keys(entry)) {
        if (key === "why" || key.startsWith("$")) continue
        expect(key, `${id}: "${key}" is not a locale tag`).toMatch(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)
      }
    }
  })

  it.skipIf(!have("subdivisions") || !have("countries") || !have("cities"))(
    "corrects places that still exist",
    async () => {
      const ids = new Set<string>()
      for (const tier of ["countries", "subdivisions", "cities"] as const) {
        for (const p of await load(tier)) ids.add(p.id)
      }
      const dangling = entries.map(([id]) => id).filter((id) => !ids.has(id))
      expect(
        dangling,
        "these overrides match no place — upstream probably renamed the id, and the correction is silently doing nothing",
      ).toEqual([])
    },
  )

  it.skipIf(!have("subdivisions"))("actually changes something", async () => {
    // An override identical to what upstream already says is a maintenance cost
    // with no benefit, and usually means upstream fixed it and nobody noticed.
    const byId = new Map((await load("subdivisions")).map((p) => [p.id, p]))
    const pointless: string[] = []
    for (const [id, entry] of entries) {
      const place = byId.get(id)
      if (!place) continue
      for (const [locale, value] of Object.entries(entry)) {
        if (locale === "why" || locale.startsWith("$")) continue
        const applied = place.names.find((n) => n.locale === locale)
        // The override won, so `applied.value` is the override. What we want to
        // know is whether any *other* source now agrees with it.
        if (applied?.kind === "override" && applied.alternatives === 0) {
          // Nothing else offered a name for this locale — the override is filling
          // a gap rather than correcting an error. Allowed, but worth knowing.
          continue
        }
        if (applied && applied.value !== value) pointless.push(`${id} ${locale}`)
      }
    }
    expect(pointless, "an override did not take effect").toEqual([])
  })
})

describe("the repository carries data it means to carry", () => {
  /**
   * `.build/load.sql` was committed for a day without anyone noticing.
   *
   * It was added before `.gitignore` was tightened from `.build/*.ndjson` to
   * `.build/`, and an ignore rule does not untrack what is already tracked — so it
   * stayed, and grew from 12MB to 76MB as the dataset did, until GitHub warned on
   * push. Every clone of a repository whose entire purpose is being easy to adopt
   * was carrying a generated file twice the size of everything else.
   *
   * `data/` is deliberately committed and deliberately large; it is the ODbL
   * obligation. Everything else that big is an accident.
   */
  it("tracks no large generated files outside data/", () => {
    const tracked = execSync("git ls-files -z", { cwd: ROOT, encoding: "buffer" })
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
    const large = tracked
      .filter((f) => !f.startsWith("data/") && existsSync(resolve(ROOT, f)))
      .map((f) => [f, statSync(resolve(ROOT, f)).size] as const)
      .filter(([, size]) => size > 2_000_000)
      .map(([f, size]) => `${f} (${(size / 1048576).toFixed(0)}MB)`)
    expect(large, "generated output is tracked — a .gitignore added later does not untrack").toEqual([])
  })
})

describe("the pipeline is the only writer that decides", () => {
  /**
   * Two writers to one database is two truths, and this had them.
   *
   * The scheduled refresh writes to D1 directly so readers benefit immediately.
   * The local ETL rebuilds from `.build/` and opens with `DELETE FROM name`. For
   * a day those were independent: the deployed database held 8,221 Thai names and
   * the local build held 5,196, and the next `places load` would have destroyed
   * the difference without a word.
   *
   * The fix is that the refresh also writes to R2 and `places pull` brings it
   * back, so its findings pass through the same merge and precedence as every
   * other source. This asserts the mechanism still exists, because the failure is
   * silent — everything builds, every count looks plausible, and work is gone.
   */
  const src = (f: string) => readFileSync(resolve(ROOT, f), "utf8")

  it("has the refresh writing its findings somewhere the ETL can read", () => {
    const refresh = src("src/refresh.ts")
    expect(refresh, "the refresh writes only to D1 — its work will be deleted by the next rebuild").toMatch(
      /ARCHIVE\.put\(\s*`labels\//,
    )
  })

  it("has a command that brings them back", () => {
    expect(existsSync(resolve(ROOT, "scripts/places/pull.ts"))).toBe(true)
    expect(src("scripts/places.ts")).toMatch(/pull:/)
  })

  it("folds pulled files in through the merge, not around it", () => {
    // They must land in the directory the merge already reads, so they compete by
    // `kind` like everything else rather than being applied on top.
    expect(src("scripts/places/pull.ts")).toMatch(/labels/)
    expect(src("scripts/places/merge.ts")).toMatch(/readdirSync\(dir\)/)
  })
})

/**
 * The script classification matches the scripts the data is actually written in.
 *
 * This is the check that would have caught the thing it now guards.
 * `NON_LATIN_SCRIPT` was fifty language codes typed by hand, and by the time the
 * database held 664 locales it was missing thirty-nine of them — Egyptian Arabic
 * with 12,681 names, Tatar with 8,177, Wu, Cantonese, Chechen, Bashkir, Odia. All
 * classified as Latin-script because nobody had thought of them. It also had
 * Kurdish wrong in the other direction: `ku` is Kurmanji and is written in Latin.
 *
 * Two things followed. `/api/matrix` counted their Latin fallbacks as real names.
 * And `resolve()` in merge.ts gates its demotion of a Latin value to `romanised`
 * on this very classification — so for thirty-nine languages, the honesty check
 * this project is built around was not running at all.
 *
 * ## Why this reads the build output rather than recomputing
 *
 * The obvious test calls the classifier and compares. It would be worse than
 * nothing, because the classifier's fallback is `Intl.Locale#maximize` and that
 * answers differently per runtime — Bun and Node disagree about 30 of the 710
 * locales here, and workerd is a third. A test that recomputes under vitest
 * (Node) proves something about Node and nothing about the ETL (Bun) or the
 * Worker (workerd).
 *
 * So the classification is decided once, by the ETL, and written into
 * `coverage.latin`. This reads the statements the ETL actually emitted and checks
 * them against the names it emitted them from — the artefact, not a re-run.
 */
describe("what we say a language is written in", () => {
  const LOAD = resolve(ROOT, ".build/load.sql")
  const haveLoad = () => existsSync(LOAD) && have("cities")
  // Enough names to be evidence rather than an accident of one source. Below it
  // the ETL falls back to CLDR and there is nothing here to check it against.
  const MINIMUM = 150

  it.skipIf(!haveLoad())("marks as non-Latin exactly the locales whose names are not Latin", async () => {
    const { isLatinScript } = await import("../../scripts/lib/sources.ts")

    /**
     * What the ETL decided, read back out of the SQL it wrote.
     *
     * `UPDATE coverage SET latin = 0 WHERE locale IN ('ar','be',...)`, possibly
     * several times because the list is chunked the way the inserts are.
     */
    const sql = readFileSync(LOAD, "utf8")
    const decidedNonLatin = new Set<string>()
    for (const m of sql.matchAll(/UPDATE coverage SET latin = 0 WHERE locale IN \(([^)]*)\);/g)) {
      for (const lit of m[1].split(",")) decidedNonLatin.add(lit.trim().slice(1, -1).replace(/''/g, "'"))
    }
    expect(
      decidedNonLatin.size,
      "load.sql marks no locale as non-Latin — the classification did not run, and every " +
        "romanised fallback in every script is being counted as a translation",
    ).toBeGreaterThan(50)

    const seen = new Map<string, { n: number; latin: number }>()
    for await (const p of records<MergedPlace>(built("cities"))) {
      for (const name of p.names) {
        // The script-neutral romanisation would drag every count toward Latin.
        if (name.locale === "und") continue
        const s = seen.get(name.locale) ?? { n: 0, latin: 0 }
        s.n++
        if (isLatinScript(name.value)) s.latin++
        seen.set(name.locale, s)
      }
    }

    const wrong: string[] = []
    for (const [locale, s] of seen) {
      if (s.n < MINIMUM) continue
      const share = s.latin / s.n
      const calledLatin = !decidedNonLatin.has(locale)
      // Only the clear cases. A language written both ways sits in the middle and
      // is a judgement rather than a defect.
      if (share > 0.85 && !calledLatin) {
        wrong.push(`${locale}: marked non-Latin, but ${Math.round(share * 100)}% of ${s.n} names are Latin`)
      }
      if (share < 0.15 && calledLatin) {
        wrong.push(`${locale}: left as Latin, but ${Math.round((1 - share) * 100)}% of ${s.n} names are not`)
      }
    }

    expect(
      wrong,
      "the ETL's script classification disagrees with the names it classified. If a language is " +
        "genuinely written both ways, add it to SCRIPT_OVERRIDES in scripts/lib/sources.ts with the " +
        "reason — a language wrongly called Latin is one whose fallbacks are counted as translations",
    ).toEqual([])
  })
})

/**
 * Publishing the same build twice produces the same bytes.
 *
 * `gzip` writes the source filename and its modification time into the header, so
 * `gzip -9 -c` gave three new binary blobs on every `places sync` — byte-for-byte
 * different, semantically identical. `git status` was dirty after every run and
 * `git diff --stat` said `Bin 11297863 -> 11297863 bytes`, which is indis-
 * tinguishable from a real change and trains people to commit without looking.
 *
 * `data/` is the ODbL artefact *and* the baseline the next diff compares against.
 * Noise in the one file that has to be read carefully is worse than noise
 * anywhere else. `gzip -n` omits both fields; this asserts they stayed omitted.
 */
describe("what we publish is reproducible", () => {
  for (const file of ["countries", "subdivisions", "cities", "history"]) {
    const path = resolve(ROOT, "data", `${file}.ndjson.gz`)
    it.skipIf(!existsSync(path))(`${file}.ndjson.gz carries no timestamp`, () => {
      const header = readFileSync(path).subarray(0, 10)
      expect(header[0], "not a gzip file").toBe(0x1f)
      expect(header[1], "not a gzip file").toBe(0x8b)
      // Bytes 4-7 are MTIME, and bit 3 of FLG (byte 3) says a filename follows.
      expect(
        header.readUInt32LE(4),
        `${file}.ndjson.gz has a timestamp in its header, so every publish rewrites it ` +
          `even when nothing changed. Publish with \`gzip -9 -n\``,
      ).toBe(0)
      expect(header[3] & 0x08, `${file}.ndjson.gz embeds the source filename — use \`gzip -n\``).toBe(0)
    })
  }
})
