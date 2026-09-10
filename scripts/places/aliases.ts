/**
 * The language alias table, taken from CLDR rather than typed out.
 *
 * The first version of this was twelve entries I wrote by hand after finding
 * Filipino split across `tl` and `fil`. CLDR ships **five hundred**, maintained,
 * with a reason on each — and it agreed with eleven of my twelve. That is the
 * same mistake as `NON_LATIN_SCRIPT`, which was fifty hand-typed codes missing
 * thirty-nine, one file over.
 *
 * ## Why generated rather than imported
 *
 * `cldr-core/supplemental/aliases.json` is 137KB and carries territory, script,
 * variant and zone aliases this service has no use for. The language table
 * compacts to 6KB, which is worth bundling into a Worker; the rest is not.
 *
 * It is committed so a clone needs no generation step, and
 * `tests/repo/locales.test.ts` regenerates it and fails if the two disagree —
 * because a generated file in git is a generated file that goes stale, and this
 * repository has already been caught by that twice.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { resolve as resolvePath } from "node:path"

const ROOT = resolvePath(import.meta.dirname, "../..")
const OUT = resolvePath(ROOT, "src/api/locale-aliases.json")

interface AliasFile {
  supplemental: {
    metadata: { alias: { languageAlias: Record<string, { _replacement: string; _reason: string }> } }
    version?: { _cldrVersion?: string }
  }
}

/**
 * The table, as `{ from: to }`.
 *
 * `_reason` is dropped: it explains CLDR's decision and this only needs the
 * decision. Entries whose replacement is several tags are dropped too — CLDR uses
 * that for a few macrolanguages that split, and "one of these three" is not an
 * answer a lookup can use. There are currently none.
 */
export function buildAliases(): { cldrVersion: string; aliases: Record<string, string> } {
  const file = JSON.parse(
    readFileSync(resolvePath(ROOT, "node_modules/cldr-core/supplemental/aliases.json"), "utf8"),
  ) as AliasFile
  const table = file.supplemental.metadata.alias.languageAlias
  const aliases: Record<string, string> = {}
  for (const [from, entry] of Object.entries(table)) {
    const to = entry._replacement
    if (to.includes(" ")) continue
    if (to === from) continue
    aliases[from] = to
  }
  return { cldrVersion: file.supplemental.version?._cldrVersion ?? "unknown", aliases }
}

export async function aliases(_argv: string[]): Promise<void> {
  const built = buildAliases()
  const body = JSON.stringify(built, null, 0) + "\n"
  writeFileSync(OUT, body)
  console.log(
    `  ${Object.keys(built.aliases).length} language aliases from CLDR ${built.cldrVersion}` +
      ` → src/api/locale-aliases.json (${(body.length / 1024).toFixed(1)}KB)`,
  )
  console.log(`  overrides where our sources disagree with CLDR are in scripts/lib/sources.ts`)
}
