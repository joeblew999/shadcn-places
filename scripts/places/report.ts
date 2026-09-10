/**
 * What coverage a language actually has — answerable before adopting it.
 *
 * The failure this prevents: a language is declared, everything reports complete
 * because every cell is non-empty, and a reader discovers months later that half
 * of it is English in Latin letters inside their script. Presence is not
 * translation, and the difference is only visible if something separates them.
 *
 * So this reports two numbers per language, never one. `named` is how many places
 * have anything at all; `translated` excludes the romanised fallbacks. For Dutch
 * the two are close and the gap does not matter. For Thai the gap *is* the answer.
 */

import { join } from "node:path"
import { records } from "../lib/ndjson.ts"
import type { MergedPlace } from "./merge.ts"

const OUT = process.env.PLACES_OUT ?? ".build"

/**
 * Languages written in a script where a Latin fallback is unreadable.
 *
 * Not a value judgement about the language — it is about the script. A Dutch
 * reader given "Ourinhos" is reading Dutch; a Thai reader given "Ourinhos" is
 * reading nothing. Those are different failures and the report must not average
 * them together.
 */
const NON_LATIN = new Set([
  "th","ja","zh","zh-CN","zh-TW","zh-HK","zh-Hant","ko","ru","uk","be","bg","sr","mk","el","hy","ka",
  "hi","bn","pa","gu","ta","te","kn","ml","si","ne","mr","my","km","lo","am","ti",
  "ar","fa","ur","ps","he","yi","dv","ug","kk","ky","mn",
])

export async function report(argv: string[]): Promise<void> {
  const only = new Set(argv.filter((a) => !a.startsWith("--")))
  const tiers = ["countries", "subdivisions", "cities"]
  const stats = new Map<string, Map<string, { named: number; translated: number }>>()
  const totals = new Map<string, number>()

  for (const tier of tiers) {
    const path = join(OUT, `${tier}.merged.ndjson`)
    let places = 0
    try {
      for await (const place of records<MergedPlace>(path)) {
        places++
        for (const n of place.names) {
          if (n.locale === "und") continue
          if (only.size && !only.has(n.locale)) continue
          const perTier = stats.get(n.locale) ?? new Map()
          const cell = perTier.get(tier) ?? { named: 0, translated: 0 }
          cell.named++
          if (n.kind === "translated" || n.kind === "native") cell.translated++
          perTier.set(tier, cell)
          stats.set(n.locale, perTier)
        }
      }
    } catch {
      continue // tier not built; report what exists rather than failing
    }
    totals.set(tier, places)
  }

  if (!stats.size) {
    console.log("nothing to report. Run: bun run places extract && bun run places merge")
    return
  }

  console.log("Coverage per language. `named` is any name at all; `translated` excludes")
  console.log("romanised fallbacks. For a non-Latin script (*) the gap between them is the story.\n")
  const header = tiers.filter((t) => totals.get(t)).map((t) => `${t} (${totals.get(t)})`)
  console.log(`  locale   ${header.map((h) => h.padStart(24)).join("")}`)

  const rows = [...stats].sort((a, b) => a[0].localeCompare(b[0]))
  for (const [locale, perTier] of rows) {
    const cells = tiers
      .filter((t) => totals.get(t))
      .map((t) => {
        const cell = perTier.get(t)
        const total = totals.get(t)!
        if (!cell) return "—".padStart(24)
        const named = Math.round((cell.named / total) * 100)
        const translated = Math.round((cell.translated / total) * 100)
        return `${named}% / ${translated}% translated`.padStart(24)
      })
    const mark = NON_LATIN.has(locale) ? "*" : " "
    console.log(`  ${(locale + mark).padEnd(8)} ${cells.join("")}`)
  }
  console.log("\n* a Latin fallback is unreadable in this script — the second number is the real one.")
}
