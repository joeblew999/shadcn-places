/**
 * Which name wins, for one place, in one language.
 *
 * The only step in this pipeline that decides anything — everything above it
 * collects candidates and is allowed to be greedy. Lifted out of
 * `scripts/places/merge.ts` so the Workflow can call exactly what the CLI calls.
 *
 * That is not tidiness. `merge` is where `tl` and `fil` become one language, where
 * a source's claim of "translated" is checked against the script it is actually
 * written in, and where six competing Thai names for Bangkok become one. Two
 * implementations of that would be two databases, and this project has already
 * shipped the two-writers-disagree bug three times: D1 against the local build,
 * the script classification asked in three runtimes, and the Cloudflare staging
 * quietly dropping a field the CLI kept.
 *
 * Pure by construction — no filesystem, no R2, no network. The transports differ
 * and the decision does not.
 */

import { KIND_RANK, canonicalLocale, isLatinLocale, isLatinScript, type Kind } from "../../scripts/lib/sources.ts"
import type { RawPlace, RawName } from "./geonames.ts"

/** What `extract` produces, under the name the ETL uses for it. */
export type Place = RawPlace
export type Name = RawName

/** Corrections from `overrides.json`, keyed by place id then locale. */
export type Overrides = Record<string, Record<string, string>>

export interface Resolved {
  locale: string
  value: string
  source: string
  kind: Kind
  /** How many other sources offered a name for this locale. Diagnostic, not display. */
  alternatives: number
}

export interface MergedPlace extends Omit<Place, "names"> {
  names: Resolved[]
}

/**
 * A value identical to the pivot is a romanisation, whatever its source claims.
 *
 * For a Latin-script language that is correct and unremarkable — Ang Thong is Ang
 * Thong in German. For Thai, Russian or Korean it means nobody translated it, and
 * labelling it `translated` would make an absence look like a presence. The
 * distinction is what `kind` exists for.
 */
/**
 * Accents removed, case flattened — enough to tell "Medea" from "Médéa".
 *
 * NFD splits a letter from its combining marks, so dropping `\p{M}` leaves the
 * base letters. Used only to decide *which* fallback label applies, never to
 * decide whether something is a fallback: a Latin-script language dropping a
 * diacritic is often writing its own correct name, and demoting Turkish
 * "İstanbul" for matching English "Istanbul" would be the same class of error
 * this function exists to prevent, pointing the other way.
 */
const fold = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()

function actualKind(name: Name, pivot: string): Kind {
  // An override is not evidence to be re-examined; a human already decided.
  if (name.kind === "override") return "override"
  if (name.kind === "native") return "native"
  // Identical to the pivot: a romanisation whatever the source called it.
  if (name.value === pivot) return "romanised"
  /**
   * Latin letters in a language that is not written in them.
   *
   * The equality test above misses the commonest form of this. GeoNames tags
   * "Changwat Bueng Kan" as Thai — it is a transliteration, it differs from the
   * pivot "Bueng Kan", and so it sailed through as a translation and was served
   * to Thai readers as though somebody had translated it.
   *
   * The script is the evidence. A Thai name contains Thai characters; if it does
   * not, nobody has written this place in Thai, and saying otherwise makes the
   * coverage numbers a claim rather than a measurement.
   *
   * Which of the two fallbacks it is depends on whether it is the pivot in
   * disguise, and the history's first entry is what showed that up. Tatar had
   * "Çikago", "Keyptawn" and "Filadelfiä" going into the same bucket as "Medea",
   * and they are not the same thing:
   *
   *   "Medea"    against pivot "Médéa"   — the pivot with its accents stripped
   *   "Çikago"   against pivot "Chicago" — somebody writing it in Tatar's Latin
   *                                        orthography, which is a real name
   *
   * Folding accents away and comparing separates them. Both are still excluded
   * from every coverage figure, so no number moves; it matters for precedence,
   * because a transliteration outranks a bare romanisation and should win when
   * both exist — and because the next person reading this data should not
   * conclude the source was lying when it was not.
   */
  if (!isLatinLocale(name.locale) && isLatinScript(name.value)) {
    return fold(name.value) === fold(pivot) ? "romanised" : "transliterated"
  }
  return name.kind
}


/**
 * A value identical to the pivot is a romanisation, whatever its source claims.
 *
 * For a Latin-script language that is correct and unremarkable — Ang Thong is Ang
 * Thong in German. For Thai, Russian or Korean it means nobody translated it, and
 * labelling it `translated` would make an absence look like a presence. The
 * distinction is what `kind` exists for.
 */
export function resolve(place: Place, overrides: Overrides = {}): Resolved[] {
  /**
   * Grouped by the *canonical* tag, which is what makes them compete at all.
   *
   * Filipino arrived as `tl` from one source and `fil` from another, and this
   * function put them in two buckets that never met. The database then held two
   * half-populated Filipinos and the API, negotiating `locale IN (locale, base)`,
   * could reach exactly one of them: `fil` reported 0% subdivisions while 446 real
   * Filipino subdivision names sat under `tl`.
   *
   * Canonicalising here rather than at read time is deliberate. It is the same
   * argument as `coverage.latin`: the merge and the Worker must agree, and the
   * only way two processes agree about a derived fact is for one of them to
   * derive it and the other to read it.
   *
   * `actualKind` is computed after the rename, so a value that is a real name in
   * one tag is not demoted for arriving under the other.
   */
  const byLocale = new Map<string, Name[]>()
  for (const [locale, value] of Object.entries(overrides[place.id] ?? {})) {
    const canonical = canonicalLocale(locale)
    byLocale.set(canonical, [{ locale: canonical, value, source: "overrides", kind: "override" }])
  }
  for (const n of place.names) {
    if (!n.value?.trim()) continue
    const locale = canonicalLocale(n.locale)
    const named = { ...n, locale }
    const list = byLocale.get(locale) ?? []
    list.push({ ...named, kind: actualKind(named, place.pivot) })
    byLocale.set(locale, list)
  }
  const out: Resolved[] = []
  for (const [locale, candidates] of byLocale) {
    candidates.sort((a, b) => KIND_RANK[b.kind] - KIND_RANK[a.kind])
    const best = candidates[0]
    out.push({ locale, value: best.value, source: best.source, kind: best.kind, alternatives: candidates.length - 1 })
  }
  out.sort((a, b) => a.locale.localeCompare(b.locale))
  return out
}
