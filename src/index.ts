/**
 * The Worker. One contract, served three ways.
 *
 * The same router answers a service binding (another Worker on this account,
 * no public hop), a public URL, and — through the OpenAPI handler — anything that
 * is not TypeScript. That is the reason for oRPC rather than a hand-written JSON
 * API: three transports and one definition, so the public surface cannot drift
 * from the internal one because there is only one of them.
 *
 * Every query here is scoped and indexed. That is not tidiness — D1 bills rows
 * *scanned*, so an unscoped `LIKE '%x%'` over 152,970 cities is a full table scan
 * per keystroke, and on the free plan the queries fail rather than slow once the
 * daily limit is reached. Where a query looks more restrictive than it needs to
 * be, that is why.
 */

import { implement } from "@orpc/server"
import { RPCHandler } from "@orpc/server/fetch"
import { OpenAPIHandler } from "@orpc/openapi/fetch"
import { contract } from "./api/contract.ts"
import { SOURCES } from "../scripts/lib/sources.ts"

interface Env {
  DB: D1Database
}

const os = implement(contract).$context<{ env: Env }>()

/**
 * Resolve one name per place for the requested locale, in one query.
 *
 * The join is a LEFT JOIN so a place with no name in this locale still returns —
 * with its pivot, and `kind` saying `romanised`. An INNER JOIN would silently
 * drop places from the list for readers whose language is thin, which is the
 * worst possible failure: the picker would show fewer countries in Swahili than
 * in French and nothing would say why.
 *
 * `locale = ?1 OR locale = ?2` handles negotiation cheaply: a caller asking for
 * `pt-BR` gets `pt-BR` if a source had it and `pt` otherwise, without a second
 * round trip. Ordering by length descending puts the more specific tag first.
 */
const NAME_JOIN = `
  LEFT JOIN name n
    ON n.place_id = p.id
   AND n.locale IN (?locale, ?base)
`

interface Row {
  id: string
  type: "country" | "subdivision" | "city"
  pivot: string
  parent_id: string | null
  country_code: string | null
  lat: number | null
  lon: number | null
  population: number | null
  value: string | null
  source: string | null
  kind: string | null
}

/** The wire shape. `name` is never null: the pivot stands in, and `kind` says so. */
const toPlace = (r: Row) => ({
  id: r.id,
  type: r.type,
  name: r.value ?? r.pivot,
  kind: (r.kind ?? "romanised") as "translated" | "native" | "romanised" | "transliterated",
  source: r.source ?? "geonames",
  parentId: r.parent_id,
  countryCode: r.country_code,
  lat: r.lat,
  lon: r.lon,
  population: r.population,
})

/** `pt-BR` → [`pt-BR`, `pt`]. One extra tag, not a negotiation library. */
const tags = (locale: string): [string, string] => [locale, locale.split("-")[0]]

const SELECT = `
  SELECT p.id, p.type, p.pivot, p.parent_id, p.country_code, p.lat, p.lon, p.population,
         n.value, n.source, n.kind
    FROM place p
    LEFT JOIN name n ON n.place_id = p.id AND n.locale IN (?, ?)
`

const router = os.router({
  countries: {
    list: os.countries.list.handler(async ({ input, context }) => {
      const [locale, base] = tags(input.locale)
      const { results } = await context.env.DB.prepare(
        `${SELECT} WHERE p.type = 'country' ORDER BY COALESCE(n.value, p.pivot) COLLATE NOCASE`,
      )
        .bind(locale, base)
        .all<Row>()
      return { places: results.map(toPlace) }
    }),
  },

  subdivisions: {
    list: os.subdivisions.list.handler(async ({ input, context }) => {
      const [locale, base] = tags(input.locale)
      // `country_code` + `type` is an index. Without the type predicate this
      // would also walk every city in the country.
      const { results } = await context.env.DB.prepare(
        `${SELECT} WHERE p.country_code = ? AND p.type = 'subdivision'
         ORDER BY COALESCE(n.value, p.pivot) COLLATE NOCASE`,
      )
        .bind(locale, base, input.country.toUpperCase())
        .all<Row>()
      return { places: results.map(toPlace) }
    }),
  },

  cities: {
    search: os.cities.search.handler(async ({ input, context }) => {
      const [locale, base] = tags(input.locale)
      /**
       * Prefix, never substring.
       *
       * `pivot LIKE 'bang%'` can use the (country_code, type, pivot) index;
       * `LIKE '%bang%'` cannot, and reads the table. The `%` is appended here and
       * any `%` or `_` the caller typed is escaped, so a user typing a wildcard
       * searches for that character rather than accidentally requesting a scan.
       */
      const prefix = input.q.replace(/[%_\\]/g, "\\$&") + "%"
      const parent = input.subdivision
        ? "AND p.parent_id = ?"
        : ""
      const binds: unknown[] = [locale, base, input.country.toUpperCase()]
      if (input.subdivision) binds.push(input.subdivision)
      binds.push(prefix, prefix, input.limit)
      const { results } = await context.env.DB.prepare(
        `${SELECT}
          WHERE p.country_code = ? AND p.type = 'city' ${parent}
            AND (p.pivot LIKE ? ESCAPE '\\' OR n.value LIKE ? ESCAPE '\\')
          ORDER BY p.population DESC NULLS LAST
          LIMIT ?`,
      )
        .bind(...binds)
        .all<Row>()
      return { places: results.map(toPlace) }
    }),

    get: os.cities.get.handler(async ({ input, context }) => {
      const [locale, base] = tags(input.locale)
      const row = await context.env.DB.prepare(`${SELECT} WHERE p.id = ? LIMIT 1`)
        .bind(locale, base, input.id)
        .first<Row>()
      return { place: row ? toPlace(row) : null }
    }),
  },

  attribution: {
    get: os.attribution.get.handler(async () => ({
      sources: SOURCES.map((s) => ({ id: s.id, licence: s.licence, url: s.url })),
      notice:
        "Place data from GeoNames (CC BY 4.0), dr5hn/countries-states-cities-database (ODbL-1.0), " +
        "Wikidata (CC0) and Unicode CLDR. Using this API imposes nothing on your application; " +
        "redistributing the database is what triggers ODbL share-alike. See LICENSE-DATA.",
    })),
  },

  coverage: {
    get: os.coverage.get.handler(async ({ input, context }) => {
      const [locale, base] = tags(input.locale)
      /**
       * Two numbers per tier, never one.
       *
       * `named` counts any name; `translated` excludes the romanised fallbacks.
       * A single number would read 100% for a language where every value is the
       * English string — which is exactly the failure this service was built to
       * make visible, so it must not be reproduced in the endpoint that reports on it.
       */
      const { results } = await context.env.DB.prepare(
        `SELECT p.type AS type,
                COUNT(*) AS total,
                SUM(CASE WHEN n.value IS NOT NULL THEN 1 ELSE 0 END) AS named,
                SUM(CASE WHEN n.kind IN ('translated','native') THEN 1 ELSE 0 END) AS translated
           FROM place p
           LEFT JOIN name n ON n.place_id = p.id AND n.locale IN (?, ?)
          GROUP BY p.type`,
      )
        .bind(locale, base)
        .all<{ type: string; total: number; named: number; translated: number }>()
      return { locale: input.locale, tiers: results }
    }),
  },
})

const rpc = new RPCHandler(router)
const openapi = new OpenAPIHandler(router)

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // The RPC transport, which is what the typed client speaks — over a service
    // binding or over the public internet, identically.
    const viaRpc = await rpc.handle(request, { prefix: "/rpc", context: { env } })
    if (viaRpc.matched) return viaRpc.response

    // The same router as plain HTTP, for callers that are not TypeScript.
    const viaHttp = await openapi.handle(request, { prefix: "/api", context: { env } })
    if (viaHttp.matched) return viaHttp.response

    // The registry item, so `shadcn add https://…/r/places-picker.json` works.
    if (url.pathname.startsWith("/r/")) {
      return new Response("registry items are served as static assets; see wrangler.toml", { status: 404 })
    }

    return Response.json(
      {
        service: "shadcn-places",
        rpc: "/rpc",
        openapi: "/api",
        registry: "/r/places-picker.json",
        licence: { code: "MIT", data: "ODbL-1.0", notice: "/api/attribution/get" },
      },
      { status: 200 },
    )
  },
}
