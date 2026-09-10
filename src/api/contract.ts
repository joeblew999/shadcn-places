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

const Kind = z.enum(["translated", "native", "romanised", "transliterated"])

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
 * oRPC will serve these over its own RPC protocol regardless, which is what the
 * typed client speaks. The explicit routes are for everyone else: a public API
 * that cannot be opened in a browser or curled without an envelope is a public
 * API people bounce off. `GET /api/countries?locale=th` is the version somebody
 * can try before deciding whether to depend on it.
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
      .route({ method: "GET", path: "/countries/{country}/subdivisions" })
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
      .route({ method: "GET", path: "/countries/{country}/cities" })
      .input(
        z.object({
          country: z.string().length(2),
          subdivision: z.string().optional(),
          q: z.string().min(1).max(64),
          locale: Locale.default("en"),
          limit: z.number().int().min(1).max(50).default(20),
        }),
      )
      .output(z.object({ places: z.array(Place) })),

    /** One city by id, for rendering a stored reference without a search. */
    get: oc
      .route({ method: "GET", path: "/cities/{id}" })
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
   * Coverage per locale, served rather than only printed.
   *
   * So that a team deciding whether to offer Swahili can ask this service instead
   * of guessing, and so that "how good is your Thai?" has an answer that is not a
   * marketing claim.
   */
  coverage: {
    get: oc
      .route({ method: "GET", path: "/coverage/{locale}" })
      .input(z.object({ locale: Locale }))
      .output(
        z.object({
          locale: z.string(),
          tiers: z.array(
            z.object({ type: z.string(), total: z.number(), named: z.number(), translated: z.number() }),
          ),
        }),
      ),
  },
}

export type Contract = typeof contract
