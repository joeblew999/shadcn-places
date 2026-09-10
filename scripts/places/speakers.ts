/**
 * How many people read each language, and where they are.
 *
 * The coverage matrix could say what is missing but not what it costs. "69,700
 * places unnamed" is identical for Khmer and for Hindi, and those are not the same
 * problem: one affects 17 million readers and the other 580 million. Ranked
 * without weighting, the next thing to fix is whichever language happens to sort
 * first.
 *
 * CLDR already carries the answer. `territoryInfo` gives each territory's
 * population and, per language spoken there, the percentage that speaks it and the
 * percentage literate in it. Summing across territories gives a global figure, and
 * keeping the per-territory breakdown gives something more useful still: **where**
 * a language's readers are, which is exactly the diagonal the coverage matrix
 * cares about. Thai readers are in Thailand, so Thai coverage of Thai cities
 * matters more than Thai coverage of Peruvian ones.
 *
 * Unicode licence, already a dependency, no new obligation. It is the same corpus
 * the country names come from.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve as resolvePath } from "node:path"

const OUT = process.env.PLACES_OUT ?? ".build"
const ROOT = resolvePath(import.meta.dirname, "../..")
const SOURCE = "https://cdn.jsdelivr.net/npm/cldr-core/supplemental/territoryInfo.json"

export interface Speakers {
  /** Global readers, summed across territories. */
  total: number
  /**
   * Where they are: territory → readers, biggest first.
   *
   * The part that makes this more than a sort key. A language's coverage gap is
   * only felt where its readers are, so a gap in Thai names for Thai places is a
   * different order of problem from a gap in Thai names for Bolivian ones.
   */
  territories: [string, number][]
}

/**
 * Literacy is applied, and that is a judgement worth stating.
 *
 * CLDR reports speakers and literacy separately. A place name is read, not heard,
 * so the population that can act on a translated name is the literate one — using
 * the raw speaker count would overstate the value of every language with low
 * literacy, which is both wrong and the sort of wrong that flatters a dashboard.
 *
 * Where CLDR gives no literacy figure the territory's own rate is used, and where
 * there is neither, the speaker count stands. An estimate beats a gap here: this
 * is a ranking, not an accounting.
 */
function readersOf(pop: number, lang: Record<string, unknown>, territoryLiteracy: number): number {
  const share = Number(lang._populationPercent ?? 0) / 100
  const literacy = Number(lang._literacyPercent ?? territoryLiteracy) / 100
  return pop * share * (Number.isFinite(literacy) && literacy > 0 ? literacy : 1)
}

export function loadSpeakers(): Map<string, Speakers> {
  const path = join(ROOT, "data", "speakers.json")
  if (!existsSync(path)) return new Map()
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, Speakers>
  return new Map(Object.entries(raw))
}

export async function speakers(argv: string[]): Promise<void> {
  const cache = join(OUT, "territoryInfo.json")
  mkdirSync(OUT, { recursive: true })
  if (!existsSync(cache) || argv.includes("--refresh")) {
    process.stdout.write("  fetching CLDR territoryInfo … ")
    const res = await fetch(SOURCE)
    if (!res.ok) throw new Error(`${SOURCE} → HTTP ${res.status}`)
    writeFileSync(cache, Buffer.from(await res.arrayBuffer()))
    console.log("ok")
  }

  const doc = JSON.parse(readFileSync(cache, "utf8")) as {
    supplemental: { territoryInfo: Record<string, Record<string, unknown>> }
  }

  const totals = new Map<string, Map<string, number>>()
  for (const [cc, info] of Object.entries(doc.supplemental.territoryInfo)) {
    const pop = Number(info._population ?? 0)
    const literacy = Number(info._literacyPercent ?? 100)
    const langs = (info.languagePopulation ?? {}) as Record<string, Record<string, unknown>>
    for (const [lang, detail] of Object.entries(langs)) {
      const readers = readersOf(pop, detail, literacy)
      if (readers < 1) continue
      // CLDR writes `pa_Arab`; BCP-47 and every locale we serve writes `pa-Arab`.
      const tag = lang.replace(/_/g, "-")
      const per = totals.get(tag) ?? new Map<string, number>()
      per.set(cc, Math.round(readers))
      totals.set(tag, per)
    }
  }

  const out: Record<string, Speakers> = {}
  for (const [lang, per] of totals) {
    const territories = [...per].sort((a, b) => b[1] - a[1])
    out[lang] = {
      total: territories.reduce((n, [, v]) => n + v, 0),
      // Truncated: the long tail of territories with a handful of readers each
      // adds bytes and changes no decision.
      territories: territories.slice(0, 12),
    }
  }

  mkdirSync(join(ROOT, "data"), { recursive: true })
  writeFileSync(join(ROOT, "data", "speakers.json"), JSON.stringify(out, null, 0) + "\n")

  const ranked = Object.entries(out).sort((a, b) => b[1].total - a[1].total)
  console.log(`\n  ${ranked.length} languages with a literate-reader estimate → data/speakers.json\n`)
  console.log("  the ten largest, and where those readers are:")
  for (const [lang, s] of ranked.slice(0, 10)) {
    const where = s.territories.slice(0, 4).map(([cc, n]) => `${cc} ${(n / 1e6).toFixed(0)}M`).join("  ")
    console.log(`    ${lang.padEnd(8)} ${(s.total / 1e6).toFixed(0).padStart(5)}M   ${where}`)
  }
  console.log("\n  Literacy is applied: a place name is read, not heard.")
}
