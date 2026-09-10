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

import { implement, onError } from "@orpc/server"
import { RPCHandler } from "@orpc/server/fetch"
import { CORSPlugin } from "@orpc/server/plugins"
import { experimental_CloudflareTracer as CloudflareTracer } from "@orpc/cloudflare"
import { OpenAPIHandler } from "@orpc/openapi/fetch"
import { OpenAPIGenerator } from "@orpc/openapi"
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4"
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

/**
 * Re-exported so the Workflow class is part of this Worker's bundle.
 *
 * A `[[workflows]]` binding names a class the deploy must be able to find; if it
 * is only defined in another module and never referenced, the deploy fails with
 * an error about a missing class rather than about a missing import.
 */
export { RefreshNames } from "./refresh.ts"

interface Env {
  DB: D1Database
  REGISTRY: Fetcher
  REFRESH: Workflow
  ARCHIVE: R2Bucket
}

/**
 * `ctx` as well as `env`, so a handler can reach `waitUntil`.
 *
 * Nothing uses it yet. It is here because adding it later means touching every
 * handler signature, and the adapter hands it over for free.
 */
const os = implement(contract).$context<{ env: Env; ctx: ExecutionContext }>()

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

      // Precomputed at load time. This aggregated `name` on every request —
      // 1.18M rows scanned, billed, per call — which is the exact mistake the
      // city search is shaped to avoid.
      const rows = await context.env.DB.prepare(
        `SELECT locale, type, real FROM coverage WHERE locale NOT LIKE '%-%'`,
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
        `SELECT locale, type, real FROM coverage`,
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
      // Two rows per tier from the precomputed table, plus the place totals,
      // instead of a left join across every name in the database.
      const totals = await context.env.DB.prepare(`SELECT type, COUNT(*) n FROM place GROUP BY type`)
        .all<{ type: string; n: number }>()
      const cov = await context.env.DB.prepare(
        `SELECT type, MAX(named) named, MAX(real) translated FROM coverage WHERE locale IN (?, ?) GROUP BY type`,
      )
        .bind(locale, base)
        .all<{ type: string; named: number; translated: number }>()
      const found = new Map(cov.results.map((r) => [r.type, r]))
      const results = totals.results.map((t) => ({
        type: t.type,
        total: t.n,
        named: found.get(t.type)?.named ?? 0,
        translated: found.get(t.type)?.translated ?? 0,
      }))
      return {
        locale: input.locale,
        latinScript: !NON_LATIN_SCRIPT.has(input.locale) && !NON_LATIN_SCRIPT.has(base),
        tiers: results,
      }
    }),
  },
})

/**
 * The OpenAPI document, generated from the same contract the Worker serves.
 *
 * The README has been telling people "there is an OpenAPI document for anything
 * that is not TypeScript" while `/openapi.json` fell through to the service's
 * root document and answered 200 with something that is not a spec. A caller
 * pointing a generator at it would get nothing, from a URL that looked fine.
 *
 * Generated rather than written, so it cannot drift: a contract change is a spec
 * change, and there is no second document to forget.
 */
const openapiSpec = new OpenAPIGenerator({ converters: [new ZodToJsonSchemaConverter()] })

/**
 * Shared handler options: CORS by plugin, and errors that are actually logged.
 *
 * The CORS headers were fifteen lines of hand-rolled header copying, added after
 * the demo could not call its own service from localhost. oRPC ships a plugin
 * that does it as part of the request rather than as a wrapper around the
 * response — which also means a preflight is answered by the handler that knows
 * the routes rather than by a blanket `if (method === "OPTIONS")`.
 *
 * `onError` is the bigger gap: this service had no error visibility at all. Every
 * failure so far was found by a person watching a page — a 500 on every
 * subdivision request, a 431 from Wikidata, a spec generator throwing inside a
 * route. All of them were invisible in the logs because nothing was writing to
 * them.
 */
/**
 * Spans per procedure, at module scope so it is registered once per isolate.
 *
 * `onError` says *that* something failed. This says where the time went — which
 * is the question nobody here has been able to answer: is a slow city search the
 * SPARQL, the D1 read, or the JSON? The matrix endpoint took 7.3 seconds for a
 * week and was only found by a test timing out.
 *
 * Marked experimental by oRPC and installed from the beta tag. Worth it: the
 * alternative is an OpenTelemetry SDK in a Worker, and the failure mode if this
 * package moves is losing traces rather than losing the service.
 *
 * `wrangler dev` shows these without deploying — press `e`, or open
 * /cdn-cgi/local/explorer.
 */
new CloudflareTracer().enable()

const handlerOptions = {
  plugins: [new CORSPlugin()],
  interceptors: [
    onError((error) => {
      console.error("orpc", error)
    }),
  ],
}

const rpc = new RPCHandler(router, handlerOptions)
const openapi = new OpenAPIHandler(router, handlerOptions)

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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)

    // Preflight. Answered before anything else so a POST from a browser does not
    // depend on the router recognising OPTIONS.
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }))

    // The RPC transport, which is what the typed client speaks — over a service
    // binding or over the public internet, identically.
    const viaRpc = await rpc.handle(request, { prefix: "/rpc", context: { env, ctx } })
    if (viaRpc.matched) return cors(viaRpc.response)

    // The same router as plain HTTP, for callers that are not TypeScript.
    const viaHttp = await openapi.handle(request, { prefix: "/api", context: { env, ctx } })
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
    /**
     * An unmatched API path is a 404, not the service document.
     *
     * `/api/cities?q=paris` matched no route and fell through to the root, which
     * answers 200 with a JSON description of the service. A caller who mistypes a
     * path gets a success and a body that parses — the worst possible response,
     * because their code carries on and fails somewhere else entirely.
     *
     * Found by a test asserting that an unscoped city search is refused. It *is*
     * refused, by there being no such route; the 200 was the problem.
     */
    /**
     * The spec, and a page to read it on.
     *
     * Scalar is a script tag pointed at the document — no build step, no bundled
     * UI, and it renders the same spec a code generator would consume. A public
     * API whose only documentation is a README is one people integrate against by
     * guessing.
     */
    if (url.pathname === "/openapi.json") {
      const spec = await openapiSpec.generate(contract, {
        info: {
          title: "shadcn-places",
          version: "0.1.0",
          description:
            "Countries, states and cities in every language the open data has. " +
            "Code MIT, data ODbL-1.0 — calling this API imposes nothing on you; redistributing the database does.",
        },
        servers: [{ url: `${url.origin}/api` }],
      })
      return cors(Response.json(spec))
    }

    if (url.pathname === "/docs") {
      return cors(
        new Response(
          `<!doctype html><html><head><meta charset="utf-8"><title>shadcn-places API</title>
           <meta name="viewport" content="width=device-width,initial-scale=1"></head>
           <body><script id="api-reference" data-url="/openapi.json"></script>
           <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        ),
      )
    }

    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/rpc/")) {
      return cors(
        Response.json(
          {
            error: "no such endpoint",
            path: url.pathname,
            // A city search must be scoped by a country: unscoped is a scan of
            // every row, per keystroke, and D1 bills what it reads.
            endpoints: [
              "GET /api/countries?locale=",
              "GET /api/subdivisions?country=",
              "GET /api/cities?country=&q=",
              "GET /api/city?id=",
              "GET /api/coverage?locale=",
              "GET /api/locales",
              "GET /api/matrix",
              "GET /api/attribution",
            ],
          },
          { status: 404 },
        ),
      )
    }

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
        openapi: "/openapi.json",
        docs: "/docs",
        licence: { code: "MIT", data: "ODbL-1.0", notice: "/api/attribution/get" },
      },
      { status: 200 },
    )
  },
}
