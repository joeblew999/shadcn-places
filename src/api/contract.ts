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
 * Every method is also a GET, and every parameter is a query parameter.
 *
 * The paths used to be RESTful — `/countries/{country}/subdivisions` — and they
 * had to change, which is worth recording because the reason is not taste.
 *
 * `@orpc/openapi` 1.15.0 cannot generate a specification for any route with a
 * dynamic path parameter. Not for a particular schema shape: for any of them.
 * A required string, a strict object, even oRPC's own `inputStructure: "detailed"`
 * all fail with *"input schema must be an object with all dynamic params as
 * required"* while the converter demonstrably emits exactly that. The routes
 * served fine at runtime — only the spec generator refused them.
 *
 * So the choice was a prettier URL or a machine-readable API, and for a service
 * whose whole argument is that anyone can adopt it, that is not a close call. A
 * public API with no spec is one people integrate against by guessing.
 *
 * `/api/subdivisions?country=BR` is also, on reflection, easier to construct by
 * hand than the path form, and it makes every endpoint the same shape.
 *
 * oRPC serves all of this over its own RPC protocol regardless, which is what the
 * typed client speaks. The explicit routes are for everyone else: a public API
 * that cannot be opened in a browser or curled without an envelope is one people
 * bounce off.
 */
export const contract = {
  countries: {
    list: oc
      .route({ method: "GET", path: "/countries" })
      .input(z.object({ locale: Locale.default("en") }))
      .output(z.object({ places: z.array(Place) })),
  },

  subdivisions: {
    list: oc
      .route({ method: "GET", path: "/subdivisions" })
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
      .route({ method: "GET", path: "/cities" })
      .input(
        z.object({
          country: z.string().length(2),
          subdivision: z.string().optional(),
          q: z.string().min(1).max(64),
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
      .route({ method: "GET", path: "/city" })
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
    get: oc.route({ method: "GET", path: "/attribution" }).input(z.object({})).output(
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
      .route({ method: "GET", path: "/locales" })
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
      .route({ method: "GET", path: "/matrix" })
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
      .route({ method: "GET", path: "/coverage" })
      .input(z.object({ locale: Locale }))
      .output(
        z.object({
          locale: z.string(),
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
