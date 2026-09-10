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
import { SOURCES, NON_LATIN_SCRIPT } from "../scripts/lib/sources.ts"
/**
 * Literate readers per language, from CLDR, bundled rather than queried.
 *
 * 20KB for every language with half a million readers or more. It is reference
 * data about languages, not about places, so it does not belong in the place
 * database — and putting it in D1 would make the matrix endpoint a join for no
 * benefit. `t` is thousands of readers; `w` is where most of them are.
 */
import SPEAKERS from "./api/speakers.json"

interface Env {
  DB: D1Database
  REGISTRY: Fetcher
}

const os = implement(contract).$context<{ env: Env }>()

/**
 * Resolve one name per place for the requested locale, in one query.
 *
 * The join is LEFT, not INNER, so a place with no name in this locale still
 * returns — with its pivot, and `kind` saying `romanised`. INNER would silently
 * drop places from the list for readers whose language is thin, which is the
 * worst available failure: the picker would show fewer countries in Swahili than
 * in French and nothing would say why.
 *
 * `locale IN (?, ?)` handles negotiation cheaply: a caller asking for `pt-BR`
 * gets `pt-BR` where a source had it and `pt` otherwise, without a second round
 * trip and without a negotiation library.
 */
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
  kind: (r.kind ?? "romanised") as "override" | "translated" | "native" | "romanised" | "transliterated",
  source: r.source ?? "geonames",
  parentId: r.parent_id,
  countryCode: r.country_code,
  lat: r.lat,
  lon: r.lon,
  population: r.population,
})

/**
 * A language's name in its own language, from the runtime's CLDR.
 *
 * `tl` is mapped to `fil` because ICU has no `tl` and does not error — it
 * silently answers in English, so a Filipino reader looking for their language
 * would find "Tagalog" spelled the way an English speaker writes it. That trap
 * has now appeared in the country names, the ETL and here.
 *
 * Falls back to the code rather than to English: a code is obviously a code, and
 * an unexpected English name reads as a translation somebody made.
 */
function endonymOf(code: string): string {
  const tag = code === "tl" ? "fil" : code
  try {
    return new Intl.DisplayNames([tag], { type: "language", fallback: "none" }).of(tag) ?? code
  } catch {
    return code
  }
}

function nameOf(code: string, inLocale: string): string {
  try {
    return new Intl.DisplayNames([inLocale], { type: "language", fallback: "none" }).of(code) ?? code
  } catch {
    return code
  }
}

/** `pt-BR` → [`pt-BR`, `pt`]. One extra tag, not a negotiation library. */
const tags = (locale: string): [string, string] => [locale, locale.split("-")[0]]

/**
 * Translated names first, then the fallbacks, each group alphabetical.
 *
 * Sorting purely by the resolved name puts every Latin fallback above every Thai
 * one, because Latin code points sort below Thai. A Thai reader opening the
 * province list therefore saw the seventeen provinces nobody had translated,
 * followed — below the fold — by the sixty-one that had been. The data was right
 * and the order buried it.
 *
 * SQLite has no locale-aware collation and D1 cannot register one, so this does
 * the part that matters: it never shows somebody a wall of a script they cannot
 * read while the names they can read sit underneath.
 */
const ORDER = `ORDER BY (n.kind IS NULL OR n.kind = 'romanised'), COALESCE(n.value, p.pivot) COLLATE NOCASE`

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
        `${SELECT} WHERE p.type = 'country' ${ORDER}`,
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
        `${SELECT} WHERE p.country_code = ? AND p.type = 'subdivision' ${ORDER}`,
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

  locales: {
    list: os.locales.list.handler(async ({ input, context }) => {
      const totals = await context.env.DB.prepare(`SELECT type, COUNT(*) n FROM place GROUP BY type`)
        .all<{ type: string; n: number }>()
      const byType = new Map(totals.results.map((r) => [r.type, r.n]))

      const rows = await context.env.DB.prepare(
        `SELECT n.locale locale, p.type type,
                SUM(CASE WHEN n.kind IN ('translated','native','override') THEN 1 ELSE 0 END) real
           FROM name n JOIN place p ON p.id = n.place_id
          WHERE n.locale != 'und' AND n.locale NOT LIKE '%-%'
          GROUP BY n.locale, p.type`,
      ).all<{ locale: string; type: string; real: number }>()

      const speakers = SPEAKERS as Record<string, { t: number; w: string[] }>
      const byLocale = new Map<string, Record<string, number>>()
      for (const r of rows.results) {
        const total = byType.get(r.type) ?? 0
        if (!total) continue
        // The pivot is the English name and is not stored as an `en` row.
        const real = r.locale === "en" ? total : r.real
        const cov = byLocale.get(r.locale) ?? {}
        cov[r.type] = Math.round((real / total) * 100)
        byLocale.set(r.locale, cov)
      }

      const out: { code: string; endonym: string; english: string; readers: number; coverage: Record<string, number> }[] = []
      for (const [code, coverage] of byLocale) {
        if ((coverage[input.tier] ?? 0) < input.min) continue
        out.push({
          code,
          endonym: endonymOf(code),
          english: nameOf(code, "en"),
          readers: (speakers[code]?.t ?? 0) * 1000,
          coverage,
        })
      }
      out.sort((a, b) =>
        input.by === "readers" ? b.readers - a.readers : a.endonym.localeCompare(b.endonym),
      )
      return { locales: out }
    }),
  },

  matrix: {
    get: os.matrix.get.handler(async ({ input, context }) => {
      const totals = await context.env.DB.prepare(`SELECT type, COUNT(*) n FROM place GROUP BY type`)
        .all<{ type: string; n: number }>()
      const byType = new Map(totals.results.map((r) => [r.type, r.n]))

      /**
       * One row per (locale, tier), counting only names a reader can actually use.
       *
       * `romanised` is excluded for every language here, including Latin-script
       * ones. That understates Dutch — where the romanisation often *is* the Dutch
       * name — and the alternative understates nothing and overstates Thai, which
       * is the more expensive mistake for a ranking whose job is to say what to
       * fix. `/coverage/{locale}` reports both numbers for anyone who needs the
       * other reading.
       */
      const rows = await context.env.DB.prepare(
        `SELECT n.locale locale, p.type type,
                SUM(CASE WHEN n.kind IN ('translated','native','override') THEN 1 ELSE 0 END) real
           FROM name n JOIN place p ON p.id = n.place_id
          WHERE n.locale != 'und'
          GROUP BY n.locale, p.type`,
      ).all<{ locale: string; type: string; real: number }>()

      const speakers = SPEAKERS as Record<string, { t: number; w: string[] }>
      const gaps: { locale: string; tier: string; coverage: number; missing: number; readers: number; where: string[] }[] = []
      for (const r of rows.results) {
        // Base languages only: a variant is answered from its base by the locale
        // negotiation above, so it is the same work item rather than another one.
        if (r.locale.includes("-")) continue
        const total = byType.get(r.type) ?? 0
        if (!total) continue
        // The pivot is the English name and is not stored as an `en` row.
        const real = r.locale === "en" ? total : r.real
        const coverage = Math.round((real / total) * 100)
        if (coverage >= 70) continue
        const who = speakers[r.locale]
        gaps.push({
          locale: r.locale,
          tier: r.type,
          coverage,
          missing: total - real,
          readers: (who?.t ?? 0) * 1000,
          where: who?.w ?? [],
        })
      }
      gaps.sort((a, b) => b.readers * b.missing - a.readers * a.missing)
      return { places: Object.fromEntries(byType), gaps: gaps.slice(0, input.limit) }
    }),
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
      return {
        locale: input.locale,
        latinScript: !NON_LATIN_SCRIPT.has(input.locale) && !NON_LATIN_SCRIPT.has(base),
        tiers: results,
      }
    }),
  },
})

const rpc = new RPCHandler(router)
const openapi = new OpenAPIHandler(router)

/**
 * Read-only, public, and therefore callable from a browser.
 *
 * A public API that a browser cannot call is a public API for servers only, and
 * half the point of shipping a picker component is that somebody's front end can
 * talk to this directly. The demo found it the honest way: served from localhost
 * it was refused by its own deployed service.
 *
 * `*` is the right answer here rather than a lax one. Every endpoint is a read of
 * data that is published under an open licence anyway, there are no credentials,
 * no cookies and nothing user-specific to leak — so an origin allowlist would
 * protect nothing and would break exactly the people this is for.
 */
const cors = (res: Response): Response => {
  const headers = new Headers(res.headers)
  headers.set("access-control-allow-origin", "*")
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS")
  headers.set("access-control-allow-headers", "content-type")
  headers.set("access-control-max-age", "86400")
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // Preflight. Answered before anything else so a POST from a browser does not
    // depend on the router recognising OPTIONS.
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }))

    // The RPC transport, which is what the typed client speaks — over a service
    // binding or over the public internet, identically.
    const viaRpc = await rpc.handle(request, { prefix: "/rpc", context: { env } })
    if (viaRpc.matched) return cors(viaRpc.response)

    // The same router as plain HTTP, for callers that are not TypeScript.
    const viaHttp = await openapi.handle(request, { prefix: "/api", context: { env } })
    if (viaHttp.matched) return cors(viaHttp.response)

    /**
     * The registry, at the URL the install command actually uses.
     *
     * `shadcn add https://…/r/places-picker.json` is the documented shape, and the
     * assets binding serves the `registry/` directory from the root — so the
     * prefix has to be stripped before the lookup. Getting this wrong is a 404 on
     * the one URL in the README that a stranger will try first, and it does not
     * fail in any build.
     */
    if (url.pathname.startsWith("/r/")) {
      const asset = new URL(url)
      asset.pathname = url.pathname.slice("/r".length)
      const found = await env.REGISTRY.fetch(new Request(asset, request))
      if (found.status !== 404) {
        // shadcn's CLI fetches this cross-origin from whatever project is
        // installing it, so it has to be readable from anywhere.
        const headers = new Headers(found.headers)
        headers.set("access-control-allow-origin", "*")
        headers.set("content-type", "application/json")
        return new Response(found.body, { status: found.status, headers })
      }
      return Response.json({ error: "no such registry item", tried: asset.pathname }, { status: 404 })
    }

    // The demo is the front page. A service whose root is a JSON document is a
    // service people evaluate by reading rather than by trying, and trying is
    // where the honest bits — the romanised markers, the coverage table — land.
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const page = await env.REGISTRY.fetch(new Request(new URL("/index.html", url), request))
      // Wrapped like every other response: the demo's live-reload polls this with
      // HEAD, and an asset served without the headers is refused by the browser
      // even same-origin. It failed silently into a catch, which is why it took a
      // console log to notice the poll had never worked.
      if (page.status !== 404) return cors(page)
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
