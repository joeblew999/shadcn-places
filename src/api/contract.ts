/**
 * The contract. One definition, three transports.
 *
 * oRPC separates the contract from how it is carried, which is the reason it is
 * here rather than a hand-rolled JSON API: the same typed client is pointed at
 * `env.PLACES.fetch` inside a Worker on this account, at a URL from anyone else's
 * runtime, and at an OpenAPI document for anything that is not TypeScript. Nobody
 * writes a second client, and the public API cannot drift from the internal one
 * because there is only one.
 *
 * Two decisions are visible in every method here and both are deliberate:
 *
 *   `locale` is a request parameter, never a build-time list. This service holds
 *   every language its sources carry; a caller asks for the one it wants. Adding
 *   a language to a consuming app therefore costs this service nothing, because
 *   there was never a list to add it to.
 *
 *   A city query cannot be expressed without a parent. Not to be strict — because
 *   D1 bills rows scanned, and an unscoped `LIKE '%x%'` reads 152,970 rows per
 *   keystroke. The type system is where that is cheapest to prevent.
 */

import { oc } from "@orpc/contract"
import { openapi } from "@orpc/openapi"
import { z } from "zod"

/** BCP-47, loosely. Rejecting exotic-but-valid tags would be worse than passing one through. */
const Locale = z.string().min(2).max(35).regex(/^[a-zA-Z0-9-]+$/)

/**
 * Kept in step with `Kind` in scripts/lib/sources.ts, and it is the contract that
 * enforces that rather than a comment.
 *
 * `override` was added to the ETL and not here, so the Worker began returning a
 * value its own output schema rejected and every subdivision request answered
 * 500. Annoying, and exactly right: a service whose responses have quietly
 * drifted from its published contract is worse than one that stops.
 */
const Kind = z.enum(["override", "translated", "native", "romanised", "transliterated"])

/**
 * What a place looks like on the wire.
 *
 * `name` is resolved for the requested locale and is never null — the pivot
 * stands in. `kind` travels with it so a caller can tell a translation from a
 * romanisation and, if it cares, render them differently. Most will not care;
 * the ones building for a non-Latin script will care a great deal.
 */
const Place = z.object({
  id: z.string(),
  type: z.enum(["country", "subdivision", "city"]),
  name: z.string(),
  /** How `name` was arrived at. `romanised` means nobody translated this yet. */
  kind: Kind,
  /** Which of our sources it came from, for attribution and for arguing with. */
  source: z.string(),
  parentId: z.string().nullable(),
  countryCode: z.string().nullable(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  population: z.number().nullable(),
})

/**
 * Every method is also a GET at a readable path.
 *
 * These were flat query-parameter routes for an afternoon, and the reason is
 * worth keeping: `@orpc/openapi` 1.15.0 could not generate a specification for
 * *any* route with a dynamic path parameter — not for a particular schema shape,
 * for all of them — while the routes served perfectly at runtime. The choice was
 * a prettier URL or a machine-readable API, which is not a close call.
 *
 * oRPC 2.0 fixes it, so the RESTful shape is back — and moving them 404'd every
 * flat URL this service had already published. `LEGACY_PATHS` in src/index.ts
 * rewrites those onto these and marks the response deprecated, and
 * tests/api/service.test.ts calls each one, because a public API that moves its
 * URLs is not one anybody builds on and a comment promising otherwise is not a
 * compatibility guarantee.
 *
 * oRPC serves all of this over its own RPC protocol regardless, which is what the
 * typed client speaks. The explicit routes are for everyone else: a public API
 * that cannot be opened in a browser or curled without an envelope is one people
 * bounce off.
 */
export const contract = {
  countries: {
    list: oc
      .meta(openapi({ method: "GET", path: "/countries" }))
      .input(z.object({ locale: Locale.default("en") }))
      .output(z.object({ places: z.array(Place) })),
  },

  subdivisions: {
    list: oc
      .meta(openapi({ method: "GET", path: "/countries/{country}/subdivisions" }))
      .input(
        z.object({
          /** ISO-3166-1 alpha-2. Required: it is the index this query rides on. */
          country: z.string().length(2),
          locale: Locale.default("en"),
        }),
      )
      .output(z.object({ places: z.array(Place) })),
  },

  cities: {
    /**
     * Prefix search inside one country, optionally one subdivision.
     *
     * `q` matches the start of a name, not the middle. A leading wildcard cannot
     * use an index, so substring search would turn every keystroke into a full
     * table scan — the exact query Cloudflare's own guidance names as the thing
     * not to do. Prefix is also what a picker actually needs: people type the
     * beginning of the place they are looking for.
     */
    search: oc
      .meta(openapi({ method: "GET", path: "/countries/{country}/cities" }))
      .input(
        z.object({
          country: z.string().length(2),
          subdivision: z.string().optional(),
          /**
           * Omit it to get the biggest cities in the country instead.
           *
           * Required until now, which meant a picker could not show anything
           * until somebody typed — and the demo only ever looked alive because it
           * shipped with a search term pre-filled. Remove the seed and the page
           * opens on an empty box, which is what a real consumer's picker did too.
           *
           * "The largest places here" is what a dropdown should open with, and it
           * is as cheap as the prefix search: same index, ordered by population,
           * same limit.
           */
          q: z.string().min(1).max(64).optional(),
          locale: Locale.default("en"),
          /**
           * A plain number. `SmartCoercionPlugin` turns the query string into one.
           *
           * This was `z.coerce.number()` — a patch on the one field that had
           * failed, after `limit=25` arrived as the string "25" and was rejected
           * over HTTP while the RPC transport (which sends real JSON numbers) was
           * fine. The plugin handles the class rather than the instance, so the
           * next numeric or boolean query parameter does not repeat it.
           */
          limit: z.number().int().min(1).max(50).default(20),
        }),
      )
      .output(z.object({ places: z.array(Place) })),

    /** One city by id, for rendering a stored reference without a search. */
    get: oc
      .meta(openapi({ method: "GET", path: "/cities/{id}" }))
      .input(z.object({ id: z.string(), locale: Locale.default("en") }))
      .output(z.object({ place: Place.nullable() })),
  },

  /**
   * What this data is made of, and what each part obliges.
   *
   * An endpoint rather than a README line because a consumer who has only ever
   * seen the API still has to be able to attribute it — CC BY requires that, and
   * a credit nobody can find programmatically is a credit that will not appear.
   */
  attribution: {
    get: oc.meta(openapi({ method: "GET", path: "/attribution" })).input(z.object({})).output(
      z.object({
        sources: z.array(z.object({ id: z.string(), licence: z.string(), url: z.string().optional() })),
        notice: z.string(),
      }),
    ),
  },

  /**
   * Which languages this service can actually offer, and how well.
   *
   * Distinct from `/matrix`, which ranks what is broken. This answers the
   * question a picker asks: *what can I put in the list, and in what order.*
   * Same data, opposite framing, and conflating them produced a language picker
   * sorted by how bad the coverage was.
   *
   * Every locale carries its **endonym** — its name in its own language —
   * because a picker exists for somebody who cannot read the current interface.
   * Nobody looking for Japanese scans for "ญี่ปุ่น".
   */
  locales: {
    list: oc
      .meta(openapi({ method: "GET", path: "/locales" }))
      .input(
        z.object({
          /**
           * Only locales with at least this much coverage in `tier`.
           *
           * The default of 50 is a judgement: below it a reader sees more
           * fallbacks than names, and offering the language implies more than is
           * there. Pass 0 for everything the database holds — 664 locales, which
           * is the right answer for exploring and the wrong one for a dropdown.
           */
          min: z.number().int().min(0).max(100).default(50),
          /** Which tier the threshold applies to. A picker for cities should ask about cities. */
          tier: z.enum(["country", "subdivision", "city"]).default("country"),
          /** Order: by how many people read it, or alphabetically by endonym. */
          by: z.enum(["readers", "name"]).default("readers"),
        }),
      )
      .output(
        z.object({
          locales: z.array(
            z.object({
              code: z.string(),
              /** The language in its own language. Falls back to the code if ICU has no name. */
              endonym: z.string(),
              /** The language named in English, for an operator reading a dashboard. */
              english: z.string(),
              /** Literate readers, from CLDR. 0 means no estimate exists, not none. */
              readers: z.number(),
              /** Coverage per tier, as a percentage a reader would actually experience. */
              coverage: z.record(z.string(), z.number()),
            }),
          ),
        }),
      ),
  },

  /**
   * The whole matrix, and what each gap costs in readers.
   *
   * `/coverage/{locale}` answers "how good is your Thai". This answers the
   * question behind it: **what does this service have and not have, and what
   * should be fixed next.**
   *
   * Served rather than only printed because the ETL is not the only thing that
   * needs to know. A consumer deciding which languages to offer, a dashboard, and
   * the next person improving the data are all asking the same question, and only
   * one of them can run a CLI.
   *
   * Ranked by readers × places unnamed. "69,700 places missing" is identical for
   * Khmer and Hindi and they are not the same problem — seventeen million readers
   * against three hundred and sixty-five. Reader counts come from CLDR's
   * `territoryInfo`, with literacy applied, because a place name is read.
   */
  matrix: {
    get: oc
      .meta(openapi({ method: "GET", path: "/matrix" }))
      .input(z.object({ limit: z.number().int().min(1).max(100).default(20) }))
      .output(
        z.object({
          places: z.record(z.string(), z.number()),
          gaps: z.array(
            z.object({
              locale: z.string(),
              tier: z.string(),
              /** Percent of places in this tier with a name a reader of this language can use. */
              coverage: z.number(),
              /** How many places that leaves unnamed. */
              missing: z.number(),
              /** Literate readers, from CLDR. Zero means CLDR has no estimate, not none. */
              readers: z.number(),
              /** Where those readers are — the territories whose places matter most for this gap. */
              where: z.array(z.string()),
            }),
          ),
        }),
      ),
  },

  /**
   * Coverage per locale, served rather than only printed.
   *
   * So that a team deciding whether to offer Swahili can ask this service instead
   * of guessing, and so that "how good is your Thai?" has an answer that is not a
   * marketing claim.
   */
  coverage: {
    get: oc
      .meta(openapi({ method: "GET", path: "/coverage/{locale}" }))
      .input(
        z.object({
          locale: Locale,
          /**
           * Scope the answer to one country — the **diagonal**.
           *
           * The single most misleading number this service produces is worldwide
           * coverage for a language spoken in one place. Hindi cities are 17% of
           * the world and **54% of India**; Thai cities are 17% of the world and
           * 89% of Thailand. Both figures are true and they mean opposite things,
           * and quoting the wrong one has misled somebody five times — four of
           * them recorded in `docs/`, and the fifth by me telling the Product
           * Owner that 17% decided whether this service was adoptable.
           *
           * Optional, because "how good is your Hindi" and "how good is your
           * Hindi in India" are different questions and only the caller knows
           * which one they are asking.
           */
          country: z.string().length(2).optional(),
        }),
      )
      .output(
        z.object({
          locale: z.string(),
          /** The country the figures are scoped to, or absent for worldwide. */
          country: z.string().nullable(),
          /**
           * Whether this locale is written in Latin script — and therefore which
           * number above is the one to read.
           *
           * For Thai or Japanese, `translated` is the real figure: a Latin string
           * is unreadable, so a name identical to the pivot is a gap.
           *
           * For Vietnamese or Indonesian it is `named`, and `translated`
           * understates badly. "Brazil" in Vietnamese is "Brazil". Our merge
           * demotes any value identical to the pivot to `romanised`, which is
           * right for detecting untranslated Thai and wrong as a quality signal
           * here — it reported Vietnamese countries at 35% when a Vietnamese
           * reader sees the correct name for all 257.
           *
           * Returned rather than assumed because only the caller knows whether
           * they are showing this to a person or counting it in a dashboard.
           */
          latinScript: z.boolean(),
          tiers: z.array(
            z.object({
              type: z.string(),
              total: z.number(),
              /** Has any name at all. The meaningful figure for a Latin-script locale. */
              named: z.number(),
              /** Excludes romanised fallbacks. The meaningful figure for every other script. */
              translated: z.number(),
            }),
          ),
        }),
      ),
  },
}

export type Contract = typeof contract
