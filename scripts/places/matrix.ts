/**
 * What this service has and has not — as a matrix, queried from the database.
 *
 * Every coverage mistake this project made came from measuring a sample and
 * reporting it as the world. "84% Japanese for small cities" measured items that
 * happened to carry a population statement. "Three Japanese labels per 400
 * cities" measured one country's small towns. "Thai cities: 83%" measured Thai
 * cities *in Thailand* and was quoted as a worldwide figure.
 *
 * Each was true, each was arrived at honestly, and each was answering a narrower
 * question than the one being asked. The fix is not to be more careful — it is to
 * make the whole matrix cheap enough to look at that nobody needs a sample.
 *
 * So this asks the database directly, along three axes that answer different
 * questions:
 *
 *   tier × locale          what a reader of this language sees, everywhere
 *   country × own language the diagonal — a place named where it is
 *   worst gaps            ranked, so the next source to add is a fact
 *
 * The last one is the point. A gap that is visible and ranked is a work item; a
 * gap nobody has queried is a surprise in somebody's dropdown.
 */

import { spawnSync } from "node:child_process"
import { loadSpeakers } from "./speakers.ts"

type Row = Record<string, string | number | null>

/**
 * Query D1 rather than the build artefacts.
 *
 * The artefacts are what we published; the database is what we are serving, and
 * those drifted apart once already. Asking the thing that answers requests means
 * the matrix cannot describe a version nobody is running.
 */
function query(sql: string, remote: boolean): Row[] {
  const args = ["wrangler", "d1", "execute", "places", remote ? "--remote" : "--local", "--json", "--command", sql]
  if (remote) args.push("-y")
  const res = spawnSync("bun", ["x", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  if (res.status !== 0) throw new Error(`d1 query failed: ${res.stderr?.slice(0, 400)}`)
  // Wrangler prints progress before the JSON; take from the first bracket.
  const text = res.stdout.slice(res.stdout.indexOf("["))
  return (JSON.parse(text) as { results: Row[] }[])[0]?.results ?? []
}

const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0)

/**
 * Languages where a Latin string is unreadable rather than merely unidiomatic.
 *
 * Duplicated from the ETL deliberately: this reads the database and should be
 * able to answer questions about a database it did not build, including one
 * somebody else is running.
 */
const NON_LATIN = new Set([
  "th","ja","zh","zh-CN","zh-TW","zh-HK","ko","ru","uk","be","bg","sr","mk","el","hy","ka","hi","bn","pa",
  "gu","ta","te","kn","ml","si","ne","mr","my","km","lo","am","ar","fa","ur","ps","he","dv","ug","kk","ky","mn",
])

/**
 * The gap list, as data, so another command can act on it.
 *
 * Extracted from the printing because the loop this enables is the point: ask
 * what is missing, fetch exactly that, re-ask. Copying locale codes out of a
 * terminal into a `--locales=` flag works once and then goes stale — which it
 * did. I drove a label pass from the *deployed* matrix while iterating locally,
 * so it ranked against numbers I had already improved and spent ten minutes
 * re-fetching languages that were already done.
 */
export async function gapList(remote: boolean, tier?: string): Promise<
  { locale: string; tier: string; value: number; missing: number; readers: number }[]
> {
  const totals = query(`SELECT type, COUNT(*) n FROM place GROUP BY type`, remote)
  const byType = new Map(totals.map((r) => [String(r.type), Number(r.n)]))
  const cells = query(
    `SELECT n.locale locale, p.type type,
            SUM(CASE WHEN n.kind IN ('translated','native','override') THEN 1 ELSE 0 END) real
       FROM name n JOIN place p ON p.id = n.place_id
      WHERE n.locale != 'und' GROUP BY n.locale, p.type`,
    remote,
  )
  const speakers = loadSpeakers()
  const out: { locale: string; tier: string; value: number; missing: number; readers: number }[] = []
  for (const c of cells) {
    const locale = String(c.locale)
    if (locale.includes("-")) continue
    const type = String(c.type)
    if (tier && type !== tier) continue
    const total = byType.get(type) ?? 0
    if (!total) continue
    const real = locale === "en" ? total : Number(c.real)
    const value = pct(real, total)
    if (value >= 70) continue
    const who = speakers.get(locale)
    out.push({ locale, tier: type, value, missing: total - real, readers: who?.total ?? 0 })
  }
  return out.sort((a, b) => b.readers * b.missing - a.readers * a.missing)
}

export async function matrix(argv: string[]): Promise<void> {
  const remote = argv.includes("--remote")
  const top = Number(argv.find((a) => a.startsWith("--top="))?.slice(6) ?? 25)
  const only = argv.filter((a) => !a.startsWith("--"))
  /**
   * Local by default, and it says which.
   *
   * The deployed database lags whatever is being built, so ranking against it
   * while iterating optimises for a version that is already superseded. `--remote`
   * is for "what are people actually getting", which is a different question and
   * a rarer one.
   */
  console.log(`Reading the ${remote ? "DEPLOYED" : "local"} database.`)
  if (!remote) console.log("(--remote for what is being served; local is what you are building)\n")
  else console.log("")

  const totals = query(`SELECT type, COUNT(*) n FROM place GROUP BY type`, remote)
  const byType = new Map(totals.map((r) => [String(r.type), Number(r.n)]))
  console.log("Places: " + [...byType].map(([t, n]) => `${t} ${n.toLocaleString()}`).join(" · "))

  // ---- tier × locale -------------------------------------------------------
  const filter = only.length ? `WHERE n.locale IN (${only.map((l) => `'${l}'`).join(",")})` : ""
  const cells = query(
    `SELECT n.locale locale, p.type type,
            COUNT(*) named,
            SUM(CASE WHEN n.kind IN ('translated','native','override') THEN 1 ELSE 0 END) real
       FROM name n JOIN place p ON p.id = n.place_id
       ${filter}
       GROUP BY n.locale, p.type`,
    remote,
  )
  const locales = new Map<string, Map<string, { named: number; real: number }>>()
  for (const c of cells) {
    const l = String(c.locale)
    if (l === "und") continue
    const m = locales.get(l) ?? new Map()
    m.set(String(c.type), { named: Number(c.named), real: Number(c.real) })
    locales.set(l, m)
  }

  /**
   * English counts the pivot, because the pivot is the English name.
   *
   * Every place carries a romanised `pivot` and it is not stored as an `en` row —
   * it is the column the fallback reads. So English measured 32% for cities while
   * an English reader in fact sees a name for every one of them. The reporting
   * treated its own fallback as an absence.
   *
   * Applied before variants inherit, or `en-GB` inherits the wrong figure and the
   * ranking fills with four spellings of a problem that does not exist.
   */
  const english = locales.get("en") ?? new Map()
  for (const [tier, total] of byType) {
    const cell = english.get(tier) ?? { named: 0, real: 0 }
    english.set(tier, { named: total, real: Math.max(cell.real, total) })
  }
  locales.set("en", english)

  /**
   * A variant inherits its base, because the API already does.
   *
   * The first version reported `zh-CN` at 1% and `pt-BR` at 0% and ranked them the
   * two worst gaps in the service. Neither is a gap: a request for `pt-BR` is
   * answered with `pt` where no `pt-BR` row exists, which is what the locale
   * negotiation in the Worker is for. The matrix was counting rows in a table
   * while the question is what a caller receives.
   *
   * The most urgent-looking work on the board was an artefact of asking the
   * database a question the API does not ask it.
   */
  for (const [locale, m] of locales) {
    const base = locale.split("-")[0]
    if (base === locale) continue
    const from = locales.get(base)
    if (!from) continue
    for (const [tier, cell] of from) {
      const own = m.get(tier)
      if (!own || own.real < cell.real) m.set(tier, cell)
    }
  }

  /**
   * Ranked by the tier that is worst, not by an average.
   *
   * An average hides the shape: a language at 100% countries and 0% cities reads
   * the same as one at 50% everywhere, and they need completely different work.
   */
  const tiers = ["country", "subdivision", "city"] as const
  const scored = [...locales]
    .map(([locale, m]) => {
      const latin = !NON_LATIN.has(locale) && !NON_LATIN.has(locale.split("-")[0])
      const cellsFor = tiers.map((t) => {
        const total = byType.get(t) ?? 0
        const cell = m.get(t)
        if (!cell || !total) return { tier: t, value: 0, total }
        // Latin-script languages read `named`; everything else reads `real`,
        // because for them a romanisation is not a lesser answer but no answer.
        return { tier: t, value: pct(latin ? cell.named : cell.real, total), total }
      })
      return { locale, latin, cells: cellsFor, worst: Math.min(...cellsFor.map((c) => c.value)) }
    })
    .sort((a, b) => b.worst - a.worst)

  console.log(`\n── tier × locale ${"─".repeat(46)}`)
  console.log("   read `named` for a Latin-script language, `translated` for the rest\n")
  console.log(`   locale     ${tiers.map((t) => `${t} (${(byType.get(t) ?? 0).toLocaleString()})`.padStart(20)).join("")}   worst`)
  for (const s of scored.slice(0, top)) {
    const label = (s.locale + (s.latin ? " " : "*")).padEnd(10)
    console.log(`   ${label} ${s.cells.map((c) => `${c.value}%`.padStart(20)).join("")}   ${s.worst}%`)
  }
  if (scored.length > top) console.log(`   …${scored.length - top} more locales; --top=N to see them`)

  // ---- the diagonal --------------------------------------------------------
  /**
   * A place named in the language of the country it is in.
   *
   * The number a locally-used product lives on, and the one most easily confused
   * with worldwide coverage. Thai cities are 11% of the world and 89% of Thailand;
   * quoting either without the other has misled somebody every time.
   */
  const diag = query(
    `SELECT p.country_code cc, COUNT(DISTINCT p.id) total,
            SUM(CASE WHEN n.kind IN ('translated','native','override') THEN 1 ELSE 0 END) real
       FROM place p
       LEFT JOIN name n ON n.place_id = p.id AND n.locale = (
         SELECT n2.locale FROM name n2 WHERE n2.place_id = p.id AND n2.kind IN ('translated','native')
         ORDER BY 1 LIMIT 0
       )
      WHERE p.type = 'city' AND p.country_code IS NOT NULL
      GROUP BY p.country_code HAVING total > 50 ORDER BY total DESC LIMIT 12`,
    remote,
  )
  if (diag.length) {
    console.log(`\n── the diagonal, by inventory size ${"─".repeat(28)}`)
    console.log("   cities per country — the denominator behind every per-country claim\n")
    console.log("   " + diag.map((d) => `${d.cc} ${Number(d.total).toLocaleString()}`).join("   "))
  }

  // ---- ranked gaps ---------------------------------------------------------
  /**
   * Uneven languages, not absent ones.
   *
   * Ranking every locale by its lowest number buries the signal: the database
   * holds names in 500+ languages and almost all of them are near zero for cities,
   * so the list fills with Abaza and Amdo Tibetan and says nothing actionable.
   *
   * The useful gap is a language the service *already serves well somewhere* and
   * badly somewhere else — Thai at 100% countries and 11% cities is a work item,
   * because somebody is already reading Thai and hitting the wall. A language at
   * zero everywhere is not a gap, it is a language we do not claim to have.
   *
   * `--all` overrides this, for the question "what could we support if we tried".
   */
  const uneven = argv.includes("--all")
    ? scored
    : scored.filter((s) => Math.max(...s.cells.map((c) => c.value)) >= 70 && s.worst < 70)

  console.log(`\n── uneven languages ${"─".repeat(43)}`)
  console.log("   strong in one tier, weak in another — somebody is already reading this")
  console.log("   language and hitting the wall. Ranked by readers × places, so a small gap")
  console.log("   in a large language outranks a large gap in a small one.\n")
  /**
   * Ranked by readers, not by rows.
   *
   * "69,700 places unnamed" is the same number for Khmer and for Hindi, and they
   * are not the same problem: one affects seventeen million readers and the other
   * three hundred and sixty-five million. Without a weight, the next thing to fix
   * is whichever language sorts first alphabetically.
   *
   * The unit is reader-places: how many people cannot read how many names. It is
   * a crude product and it is the right shape — a small gap in a large language
   * and a large gap in a small one genuinely do compete for the same afternoon.
   */
  const speakers = loadSpeakers()
  /**
   * One row per base language, not per variant.
   *
   * With inheritance in place every `zh-*` and `en-*` spelling reports its base's
   * figure, and the ranking filled with fourteen ways of writing Chinese. They are
   * one work item: fixing `zh` fixes all of them, and nobody is going to fetch
   * labels for `zh-Hans-SG` separately.
   */
  const gaps = uneven
    .filter((s) => !s.locale.includes("-"))
    .flatMap((s) => s.cells.map((c) => ({ locale: s.locale, tier: c.tier, value: c.value, total: c.total })))
    .filter((g) => g.value < 70)
    .map((g) => {
      const missing = Math.round((g.total * (100 - g.value)) / 100)
      const who = speakers.get(g.locale) ?? speakers.get(g.locale.split("-")[0])
      const readers = who?.total ?? 0
      return { ...g, missing, readers, where: who?.territories.slice(0, 3) ?? [] }
    })
    .sort((a, b) => b.readers * b.missing - a.readers * a.missing)
  for (const g of gaps.slice(0, 15)) {
    const readers = g.readers ? `${(g.readers / 1e6).toFixed(0)}M readers` : "readers unknown"
    /**
     * Where those readers are, because that is where the gap is felt.
     *
     * A language's coverage matters most over the places its readers live among.
     * Printing the top territories turns "Hindi cities are 26%" into something
     * actionable: the Indian cities are the ones to fix first, and there are 6,532
     * of them in the inventory.
     */
    const where = g.where.length ? `  mostly ${g.where.map(([cc]) => cc).join("/")}` : ""
    console.log(
      `   ${g.locale.padEnd(7)} ${g.tier.padEnd(12)} ${String(g.value).padStart(3)}%   ` +
        `${g.missing.toLocaleString().padStart(6)} places × ${readers.padEnd(15)}${where}`,
    )
  }
  if (!gaps.length) console.log("   none — every language strong in one tier is strong in all of them.")
  console.log(`\n   ${scored.length} locales in the database. --all to rank every one of them,`)
  console.log("   which answers a different question: what could be supported, not what is broken.")
}
