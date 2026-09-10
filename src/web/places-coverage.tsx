/**
 * What this service actually has, per language, as something a person can read.
 *
 * `places matrix` prints a table that is fine in a terminal and unreadable to
 * anyone deciding whether to adopt this. The same numbers as colour, ranked by
 * readers affected, answer the question people actually have — *is this good
 * enough for my languages* — in about two seconds.
 *
 * It is a registry item rather than a page in the demo for a reason beyond
 * tidiness: anyone self-hosting from the ODbL dumps has different coverage from
 * ours the moment they re-run the ETL, and a component they install is the only
 * version of this that stays true for them.
 *
 * ## The two numbers, and why both are always shown
 *
 * **named** counts places with any name at all in the language. **translated**
 * excludes the romanised fallbacks — a value identical to the English pivot.
 *
 * Neither is "the" coverage, and picking one is how this project has misled
 * itself five times. For Spanish, `named` is the real figure: São Paulo is São
 * Paulo in Spanish, so a name identical to the pivot is correct. For Thai it is
 * `translated`: a Latin string is not a lesser translation but an unreadable one.
 *
 * `latinScript` on each row says which one to read, and this renders the
 * meaningful one prominently and the other beside it. A single number would let
 * a reader conclude Spanish cities are at 14% when a Spanish reader gets a
 * correct name for 51% of them — which is exactly what our own ranking did until
 * somebody looked.
 */

"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

/** One language's coverage, per tier. `/api/locales` returns this shape. */
export interface CoverageRow {
  /** BCP-47. */
  code: string
  /** The language in its own language. */
  endonym: string
  /** The language in English, for whoever is reading a dashboard. */
  english?: string
  /** Literate readers. 0 means CLDR has no estimate, not that nobody reads it. */
  readers?: number
  /** Percent per tier, already resolved to the figure that means something for this language. */
  coverage: Record<string, number>
  /**
   * Whether a Latin string reads correctly in this language.
   *
   * Optional because `/api/locales` does not return it — that endpoint has
   * already applied it. Supply it if you have it and the table will say which
   * number it is showing.
   */
  latinScript?: boolean
  /** Where those readers are. Renders as a hint on the row. */
  where?: string[]
}

export interface PlacesCoverageProps {
  /** The rows to show. Fetch them with `/api/locales?min=0&by=readers`. */
  rows: CoverageRow[]
  /** Which tiers to show, in order. Defaults to the three this service holds. */
  tiers?: string[]
  /** How many places exist in each tier — the denominator behind every percentage. */
  totals?: Record<string, number>
  /**
   * How many rows to render. Defaults to 30.
   *
   * The database holds hundreds of languages and almost all of them are near
   * zero for cities, so an uncapped table fills with rows nobody is deciding
   * about and buries the ones they are.
   */
  limit?: number
  /**
   * Hide languages CLDR has no reader estimate for. On by default.
   *
   * A table sorted by impact cannot rank a row whose impact is unknown, and
   * showing it anyway implies a zero that is not in the data.
   */
  readersOnly?: boolean
  className?: string
  caption?: React.ReactNode
}

/**
 * Three bands, not a gradient.
 *
 * A continuous colour scale reads as precision this data does not have — the
 * difference between 61% and 64% is noise from one source's release. Three bands
 * say the only thing anybody acts on: usable, patchy, or not really there.
 */
function band(pct: number): { label: string; className: string } {
  if (pct >= 70) return { label: "good", className: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" }
  if (pct >= 30) return { label: "partial", className: "bg-amber-500/15 text-amber-700 dark:text-amber-400" }
  return { label: "thin", className: "bg-rose-500/15 text-rose-700 dark:text-rose-400" }
}

/** 1,393,232,000 → "1393M". Readers are only ever compared, never totalled. */
function readable(readers: number | undefined): string {
  if (!readers) return "—"
  if (readers >= 1e6) return `${Math.round(readers / 1e6)}M`
  return "<1M"
}

export function PlacesCoverage({
  rows,
  tiers = ["country", "subdivision", "city"],
  totals,
  limit = 30,
  readersOnly = true,
  className,
  caption,
}: PlacesCoverageProps) {
  const shown = React.useMemo(() => {
    const kept = readersOnly ? rows.filter((r) => (r.readers ?? 0) > 0) : rows
    return [...kept].sort((a, b) => (b.readers ?? 0) - (a.readers ?? 0)).slice(0, limit)
  }, [rows, readersOnly, limit])

  return (
    <div className={cn("w-full overflow-x-auto", className)}>
      <Table>
        {caption !== null && (
          <TableCaption>
            {caption ?? (
              <>
                {rows.length.toLocaleString()} languages, {shown.length} shown
                {readersOnly && rows.length > shown.length && " — those with a reader estimate"}.
                Green is 70% or more, amber 30–70%, red below.
              </>
            )}
          </TableCaption>
        )}
        <TableHeader>
          <TableRow>
            <TableHead>Language</TableHead>
            <TableHead className="text-right">Readers</TableHead>
            {tiers.map((tier) => (
              <TableHead key={tier} className="text-right capitalize">
                {tier}
                {totals?.[tier] !== undefined && (
                  <span className="ml-1 font-normal text-muted-foreground">
                    ({totals[tier].toLocaleString()})
                  </span>
                )}
              </TableHead>
            ))}
            <TableHead className="text-right">Where</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((row) => (
            <TableRow key={row.code}>
              <TableCell>
                {/* The endonym first: a reader looking for their own language
                    scans for the word they call it, not the word we call it. */}
                <span className="font-medium">{row.endonym}</span>
                <span className="ml-2 text-xs text-muted-foreground">{row.code}</span>
                {row.latinScript === false && (
                  <span
                    className="ml-1 text-xs text-muted-foreground"
                    title="Not written in Latin script — a name identical to the English one is a gap here, not a translation"
                  >
                    *
                  </span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {readable(row.readers)}
              </TableCell>
              {tiers.map((tier) => {
                const pct = row.coverage[tier] ?? 0
                const b = band(pct)
                return (
                  <TableCell key={tier} className="text-right">
                    <Badge variant="secondary" className={cn("tabular-nums font-normal", b.className)} title={b.label}>
                      {pct}%
                    </Badge>
                  </TableCell>
                )
              })}
              <TableCell className="text-right text-xs text-muted-foreground">
                {row.where?.join(" ") ?? ""}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {shown.some((r) => r.latinScript === false) && (
        <p className="mt-2 text-xs text-muted-foreground">
          * not written in Latin script. For those languages a name identical to the English one is
          a gap; for the rest it is usually the correct word.
        </p>
      )}
    </div>
  )
}

/**
 * The diagonal: how well a country's own places are named in that country's language.
 *
 * The number a locally-used product lives on, and the one most easily confused
 * with worldwide coverage. Thai cities are 17% of the world and 89% of Thailand,
 * and quoting either without the other has misled somebody every time it has
 * happened here — four times, all recorded.
 *
 * Shown beside the matrix rather than inside it because they answer different
 * questions. The matrix says *can I ship this language*. This says *can I ship
 * this language in this market*, which for most products is the one that decides.
 */
export interface DiagonalRow {
  /** ISO 3166-1 alpha-2. */
  country: string
  /** The country in the reader's language, if you have it. Falls back to the code. */
  name?: string
  /** The language that country reads, as a tag. */
  locale: string
  /** Places in that country, in the tier being reported. The denominator. */
  total: number
  /** How many of them have a real name in that language. */
  named: number
}

export function PlacesDiagonal({
  rows,
  limit = 12,
  className,
}: {
  rows: DiagonalRow[]
  limit?: number
  className?: string
}) {
  const shown = React.useMemo(
    () => [...rows].sort((a, b) => b.total - a.total).slice(0, limit),
    [rows, limit],
  )
  return (
    <div className={cn("w-full overflow-x-auto", className)}>
      <Table>
        <TableCaption>
          A place named in the language of the country it is in — the figure a product serving one
          market lives on, and the one most often confused with worldwide coverage.
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Country</TableHead>
            <TableHead>Language</TableHead>
            <TableHead className="text-right">Places</TableHead>
            <TableHead className="text-right">Named</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((row) => {
            const pct = row.total ? Math.round((row.named / row.total) * 100) : 0
            const b = band(pct)
            return (
              <TableRow key={`${row.country}:${row.locale}`}>
                <TableCell className="font-medium">
                  {row.name ?? row.country}
                  {row.name && <span className="ml-2 text-xs text-muted-foreground">{row.country}</span>}
                </TableCell>
                <TableCell className="text-muted-foreground">{row.locale}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {row.total.toLocaleString()}
                </TableCell>
                <TableCell className="text-right">
                  <Badge variant="secondary" className={cn("tabular-nums font-normal", b.className)}>
                    {pct}%
                  </Badge>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
