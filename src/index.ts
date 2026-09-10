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
import type { StandardHandlerInterceptor } from "@orpc/server/standard"
import { RPCHandler } from "@orpc/server/fetch"
import { CORSHandlerPlugin, BatchHandlerPlugin } from "@orpc/server/plugins"
import { OpenAPIReferenceHandlerPlugin } from "@orpc/openapi/plugins"
import { SmartCoercionHandlerPlugin } from "@orpc/json-schema"
import { EvlogHandlerPlugin } from "@orpc/evlog"
import { experimental_CloudflareTracer as CloudflareTracer } from "@orpc/cloudflare"
import { OpenAPIGenerator } from "@orpc/openapi"
import { OpenAPIHandler } from "@orpc/openapi/fetch"
import { ZodToJsonSchemaConverter } from "@orpc/zod"
import { contract } from "./api/contract.ts"
import { SOURCES, canonicalLocale, isLatinLocale } from "../scripts/lib/sources.ts"
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

/**
 * `Env` is generated from wrangler.jsonc by `bun run types`, not written here.
 *
 * It used to be four hand-maintained lines, which meant a binding could be added
 * to the config and forgotten here — or removed from the config and still
 * referenced — with nothing to say so. The generated interface comes from the
 * bindings that will actually exist at runtime, so the two cannot disagree.
 *
 * It also carries the Workers runtime types. Without them `D1Database`,
 * `R2Bucket` and `ExecutionContext` are simply unknown names, which is what this
 * file had — invisible, because it was outside the typecheck entirely.
 */

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

/**
 * English is the pivot, so it is never a fallback.
 *
 * `romanised` means two different things that happen to be the same string here:
 * *this is the Latin form* and *nobody has translated this into your language*.
 * For every other language those coincide usefully. For English they are opposite
 * — the pivot **is** the English name — and the merge demotes every `en` row to
 * `romanised` because its value equals the pivot, which is true and useless.
 *
 * The demo made it visible the moment it stopped defaulting to Japanese: all 257
 * countries rendered with the "not translated" marker for an English reader.
 *
 * Underneath it was one fact — the pivot is the English name — patched in three
 * places and nowhere consistently. `/api/matrix` and `/api/locales` special-cased
 * `en` to 100%. `/api/coverage/en` reported `named 100%, translated 0%`. And the
 * list said every row was a fallback. Three answers to one question, which is the
 * failure this project keeps arriving at from new directions.
 */
const isEnglish = (locale: string) => locale === "en" || locale.startsWith("en-")

/** The wire shape. `name` is never null: the pivot stands in, and `kind` says so. */
const toPlace = (r: Row, english = false) => ({
  id: r.id,
  type: r.type,
  name: r.value ?? r.pivot,
  kind: (english && (r.kind === "romanised" || r.kind == null)
    ? "translated"
    : r.kind ?? "romanised") as "override" | "translated" | "native" | "romanised" | "transliterated",
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

/**
 * `pt-BR` → [`pt-BR`, `pt`]. One extra tag, not a negotiation library.
 *
 * Canonicalised first, using the same CLDR table the merge used to store the
 * names. Without it a caller asking for `tl` is answered from an empty `tl`
 * while every Filipino name sits under `fil` — which is exactly what happened,
 * and it looked like a language this service simply did not have.
 */
const tags = (locale: string): [string, string] => {
  const canonical = canonicalLocale(locale)
  return [canonical, canonical.split("-")[0]]
}

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
      const english = isEnglish(input.locale)
      return { places: results.map((r) => toPlace(r, english)) }
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
      const english = isEnglish(input.locale)
      return { places: results.map((r) => toPlace(r, english)) }
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
      const english = isEnglish(input.locale)
      return { places: results.map((r) => toPlace(r, english)) }
    }),

    get: os.cities.get.handler(async ({ input, context }) => {
      const [locale, base] = tags(input.locale)
      const row = await context.env.DB.prepare(`${SELECT} WHERE p.id = ? LIMIT 1`)
        .bind(locale, base, input.id)
        .first<Row>()
      return { place: row ? toPlace(row, isEnglish(input.locale)) : null }
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
        `SELECT locale, type, named, real, latin FROM coverage WHERE locale NOT LIKE '%-%'`,
      ).all<{ locale: string; type: string; named: number; real: number; latin: number }>()

      const speakers = SPEAKERS as Record<string, { t: number; w: string[] }>
      const byLocale = new Map<string, Record<string, number>>()
      for (const r of rows.results) {
        const total = byType.get(r.type) ?? 0
        if (!total) continue
        /**
         * Script-aware, like the matrix — and here it decides what a person sees.
         *
         * This is the endpoint a language picker calls, and `min` filters on the
         * number it returns. Counting `real` for Latin-script languages reported
         * Spanish cities at 14% when a Spanish reader gets a correct name for
         * 51% of them, so a picker asking for `min=50&tier=city` dropped Spanish
         * off its own list.
         */
        const real = r.locale === "en" ? total : r.latin ? r.named : r.real
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
       * Both numbers per (locale, tier), and the script decides which one counts.
       *
       * This read `real` alone — every romanised fallback excluded, for every
       * language — and the note defending it said that understating Dutch was
       * safer than overstating Thai. That was wrong, and it was wrong in a way
       * that cost work rather than accuracy.
       *
       * Measured after the OSM pass: Spanish cities are `named` 51% and
       * `translated` 14%. The 37-point difference is names identical to the
       * English pivot — and for Spanish those are usually *correct*, because São
       * Paulo is São Paulo in Spanish. So the ranking put Spanish second in the
       * world with 59,838 cities "missing", roughly two thirds of which are not
       * missing at all.
       *
       * That is not a cosmetic error. This ranking is what `gapLocales()` in
       * refresh.ts reads to choose which languages get the weekly SPARQL budget,
       * so it was aiming a scarce, rate-limited resource at Spanish, Portuguese
       * and Indonesian — where the fallback already reads correctly — instead of
       * at Hindi, Bengali and Arabic, where it does not.
       *
       * `/coverage/{locale}` has returned `latinScript` from the beginning,
       * telling callers which of the two numbers to read. The fix is for this
       * endpoint to take its own advice.
       */
      const rows = await context.env.DB.prepare(
        `SELECT locale, type, named, real, latin FROM coverage`,
      ).all<{ locale: string; type: string; named: number; real: number; latin: number }>()

      const speakers = SPEAKERS as Record<string, { t: number; w: string[] }>
      const gaps: { locale: string; tier: string; coverage: number; missing: number; readers: number; where: string[] }[] = []
      for (const r of rows.results) {
        // Base languages only: a variant is answered from its base by the locale
        // negotiation above, so it is the same work item rather than another one.
        if (r.locale.includes("-")) continue
        const total = byType.get(r.type) ?? 0
        if (!total) continue
        /**
         * The number a reader of *this* language would actually experience.
         *
         * Latin-script: `named`, because a value equal to the pivot is usually
         * the right word. Everything else: `real`, because a Latin string is
         * unreadable however correct it is in English.
         *
         * A locale absent from `NON_LATIN_SCRIPT` is treated as Latin, which
         * overstates it. That is the failure direction to be nervous about, and
         * it is why the set is a maintained list rather than a guess from the
         * language tag — a script this project has not thought about should be
         * added to the set, and until then it shows up as suspiciously complete
         * rather than silently absent.
         */
        const latin = r.latin === 1
        // The pivot is the English name and is not stored as an `en` row.
        const real = r.locale === "en" ? total : latin ? r.named : r.real
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
        `SELECT type, MAX(named) named, MAX(real) translated, MIN(latin) latin FROM coverage WHERE locale IN (?, ?) GROUP BY type`,
      )
        .bind(locale, base)
        .all<{ type: string; named: number; translated: number; latin: number }>()
      const found = new Map(cov.results.map((r) => [r.type, r]))
      // MIN across the tiers: they are all the same locale, so they all carry the
      // same flag, and MIN picks it without caring which tier came back.
      const stored = cov.results[0]?.latin
      /**
       * English is complete by construction, and this endpoint used to deny it.
       *
       * The pivot *is* the English name, and the merge files every `en` row as
       * `romanised` because its value equals the pivot. So this reported English
       * countries as `named 100%, translated 0%` while `/api/matrix` and
       * `/api/locales` both special-cased `en` to 100% — the same fact, answered
       * three ways by one service.
       *
       * Answered here the way the other two answer it. The special case is not a
       * fudge: there is genuinely nothing missing, because the fallback and the
       * translation are the same string.
       */
      const english = isEnglish(input.locale)
      const results = totals.results.map((t) => ({
        type: t.type,
        total: t.n,
        named: english ? t.n : found.get(t.type)?.named ?? 0,
        translated: english ? t.n : found.get(t.type)?.translated ?? 0,
      }))
      return {
        locale: input.locale,
        /**
         * From the database where we hold names for this locale, and only from
         * `Intl` when we do not.
         *
         * The stored value is the one the merge acted on when it decided which
         * names were translations and which were fallbacks, so reporting it keeps
         * this endpoint consistent with the numbers beside it. Asking workerd's
         * own ICU would be asking a different question in a different runtime and
         * calling the answers the same thing.
         *
         * The fallback only fires for a locale with no coverage row — one we hold
         * no names for at all, whose tiers are therefore all zero, so the worst a
         * runtime disagreement can do here is label an empty result.
         */
        latinScript: stored === undefined ? isLatinLocale(locale) && isLatinLocale(base) : stored === 1,
        tiers: results,
      }
    }),
  },
})

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

const zodConverter = new ZodToJsonSchemaConverter()

/**
 * The spec, generated once per isolate and reused.
 *
 * 2.0's reference plugin takes a *document* rather than the converters and
 * generate-options 1.x took — which is more work here and the right shape: the
 * spec is now an ordinary value this module owns, so `/api/spec.json`, a
 * generator and a test all read the same object instead of three call sites
 * passing three sets of options to the same generator.
 *
 * `servers` is relative on purpose. An absolute origin would be wrong the moment
 * this is called through a custom domain or a preview deployment, and a spec that
 * names the wrong host generates clients that talk to the wrong host.
 *
 * Generated lazily and memoised: it walks every schema in the contract, which is
 * not work to do at module scope on an isolate that may only ever serve one city
 * search.
 */
const generator = new OpenAPIGenerator({ converters: [zodConverter] })
let specPromise: Promise<Awaited<ReturnType<typeof generator.generate>>> | undefined
const spec = () =>
  (specPromise ??= generator.generate(contract, {
    /**
     * 3.1.0 rather than 2.0's 3.2.0 default.
     *
     * 3.2 is months old and most generators — openapi-generator, oapi-codegen,
     * the Go and Rust ones people would point at this — do not read it yet. oRPC
     * generates 3.2 and downgrades, so asking for 3.1 costs nothing here and is
     * the difference between a spec somebody can run a code generator over and
     * one they cannot.
     */
    version: "3.1.0",
    // Document fields moved under `base` in 2.0; they were top-level in 1.x.
    base: {
      info: {
        title: "shadcn-places",
        version: "0.1.0",
        description:
          "Countries, states and cities in every language the open data has. " +
          "Code MIT, data ODbL-1.0 — calling this API imposes nothing on you; redistributing the database does.",
      },
      servers: [{ url: "/api" }],
    },
  }))

/**
 * Built per handler rather than shared, because 2.0 types interceptors by context.
 *
 * A single `const errorLogging = [...]` array is inferred once, in a position
 * with no contextual type, and is then assignable to neither handler. Written as
 * a function it is inferred at each call site against the handler's own options,
 * which is where the context type is. Same two lines of behaviour; the
 * alternative is an `as any` over the one thing in this file whose job is to make
 * failures visible.
 */
type ServiceContext = { env: Env; ctx: ExecutionContext }

const logErrors = (): StandardHandlerInterceptor<ServiceContext> =>
  onError((error: unknown) => {
    console.error("orpc", error)
  })

/**
 * The RPC transport: CORS, structured logs, and request batching.
 *
 * `EvlogHandlerPlugin({ logAbort: true })` is the pair to `enable_request_signal`.
 * The flag makes an abandoned request actually abort; this records that it did,
 * which is the difference between "requests got cheaper" and knowing it.
 *
 * `BatchHandlerPlugin` lets a client send several calls in one HTTP request. The
 * picker's cascade is three sequential calls on a slow connection — country, then
 * subdivisions, then a search — and a consumer that batches pays one round trip
 * instead of three. Costs nothing when nobody uses it.
 */
const rpc = new RPCHandler(router, {
  plugins: [new CORSHandlerPlugin(), new EvlogHandlerPlugin({ logAbort: true }), new BatchHandlerPlugin()],
  interceptors: [logErrors()],
})

/**
 * The HTTP transport, with two plugins that replace things I hand-rolled badly.
 *
 * `SmartCoercionHandlerPlugin` coerces query strings to the types the schema
 * declares. `limit` arrived as the string "25" and failed validation — over HTTP
 * only, because the RPC transport sends real JSON numbers — and I fixed it by
 * putting `z.coerce` on that one field. This fixes the *class*: every future
 * numeric or boolean query parameter is handled, rather than the next one failing
 * the same way and being patched the same way.
 *
 * `OpenAPIReferenceHandlerPlugin` serves the spec and a reference UI as part of
 * the handler. Mine were two hand-written routes — a generator call and a string
 * of HTML with a Scalar script tag — sitting outside the thing that knows the
 * routes. This is the same output from the component that owns it.
 */
const openapi = new OpenAPIHandler(router, {
  plugins: [
    new CORSHandlerPlugin(),
    new EvlogHandlerPlugin({ logAbort: true }),
    /**
     * Handed the Zod converter, which is the part that was missing before.
     *
     * On 1.x there were two of these: a generic `SmartCoercionPlugin` from
     * `@orpc/json-schema` and a Zod-specific one from `@orpc/zod/zod4`. I used the
     * generic one with no converters, it coerced nothing, I removed the
     * `z.coerce` workaround on the assumption that it had, and broke the deployed
     * service for two minutes.
     *
     * 2.0 has one plugin and it takes `converters`. That is the whole fix: with
     * the Zod converter it can see that `limit` is a number, and without it the
     * plugin has no schema to read and silently does nothing — which is exactly
     * the shape of the original failure.
     *
     * Verified against a running server before deploying, not assumed. The test
     * `accepts limit from a query string` is what says so.
     */
    new SmartCoercionHandlerPlugin({ converters: [zodConverter] }),
    new OpenAPIReferenceHandlerPlugin({ spec }),
  ],
  interceptors: [logErrors()],
})

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

/**
 * The flat query-parameter URLs this service was published with.
 *
 * Every method used to be `/api/<thing>?parent=…`, because `@orpc/openapi` 1.15
 * could not generate a specification for *any* route with a dynamic path
 * parameter. oRPC 2.0 fixes that and the RESTful paths are back — which silently
 * 404'd all four of these until this existed.
 *
 * Rewritten rather than redirected. A 308 is the tidier answer and it breaks
 * `curl` without `-L`, which is exactly how somebody would have tried this API
 * from a terminal. The point of keeping an old URL alive is that code written
 * against it keeps working, and a redirect only mostly achieves that.
 *
 * `Deprecation` and `Link` (RFC 8594) go on the response, so a caller who looks
 * is told, and one who does not is not broken. This mapping should be deletable
 * once nothing asks for these — not before, and not on my judgement of how long
 * that is.
 */
const LEGACY_PATHS: Record<string, { param: string; to: (v: string) => string }> = {
  "/api/subdivisions": { param: "country", to: (v) => `/api/countries/${v}/subdivisions` },
  "/api/cities": { param: "country", to: (v) => `/api/countries/${v}/cities` },
  "/api/city": { param: "id", to: (v) => `/api/cities/${encodeURIComponent(v)}` },
  "/api/coverage": { param: "locale", to: (v) => `/api/coverage/${encodeURIComponent(v)}` },
}

/**
 * Rewrite a legacy URL, or return null if it is not one.
 *
 * The parameter is moved out of the query string as well as into the path.
 * Leaving it in is harmless for three of these and wrong for `city`, where the
 * id would arrive twice; and a schema that has already consumed a path parameter
 * has no reason to see it again.
 */
function rewriteLegacy(url: URL): URL | null {
  const rule = LEGACY_PATHS[url.pathname]
  if (!rule) return null
  const value = url.searchParams.get(rule.param)
  // Without the parameter there is no path to rewrite to. Falls through to the
  // 404, which lists the endpoints — a better answer than a malformed redirect.
  if (!value) return null
  const next = new URL(url)
  next.pathname = rule.to(value)
  next.searchParams.delete(rule.param)
  return next
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

    // Not a route today; was one this morning. Answered from the new path, and
    // told so in the headers.
    const legacy = rewriteLegacy(url)
    if (legacy) {
      const viaLegacy = await openapi.handle(new Request(legacy, request), {
        prefix: "/api",
        context: { env, ctx },
      })
      if (viaLegacy.matched) {
        const res = cors(viaLegacy.response)
        const headers = new Headers(res.headers)
        headers.set("deprecation", "true")
        headers.set("link", `<${legacy.pathname}>; rel="successor-version"`)
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
      }
    }

    /**
     * The URLs the README published, pointing at what the plugin serves.
     *
     * `OpenAPIReferencePlugin` puts the spec at `/api/spec.json` and the reference
     * UI at `/api`, generated by the component that owns the routes. My versions
     * were two hand-written handlers — a generator call and a string of Scalar
     * HTML — doing the same job from outside, and the plugin's cannot drift from
     * the handler because it *is* the handler.
     *
     * Redirected rather than deleted: `/openapi.json` and `/docs` went in the
     * README an hour ago, and a public API that moves its documentation URL a day
     * after publishing it is not one anybody trusts.
     */
    if (url.pathname === "/openapi.json") {
      return Response.redirect(new URL("/api/spec.json", url).toString(), 301)
    }
    if (url.pathname === "/docs") {
      return Response.redirect(new URL("/api", url).toString(), 301)
    }

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
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/rpc/")) {
      return cors(
        Response.json(
          {
            error: "no such endpoint",
            path: url.pathname,
            // A city search must be scoped by a country: unscoped is a scan of
            // every row, per keystroke, and D1 bills what it reads. That is why
            // the country is in the path and not optional in the query.
            endpoints: [
              "GET /api/countries?locale=",
              "GET /api/countries/{country}/subdivisions",
              "GET /api/countries/{country}/cities?q=",
              "GET /api/cities/{id}",
              "GET /api/coverage/{locale}",
              "GET /api/locales",
              "GET /api/matrix",
              "GET /api/attribution",
              "GET /api/spec.json",
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
        registry: "/r/places-picker.json",
        // `openapi` was in here twice — the second silently won, so the first
        // value was never served and nothing said so. It typechecks now.
        openapi: "/api/spec.json",
        docs: "/api",
        licence: { code: "MIT", data: "ODbL-1.0", notice: "/api/attribution" },
      },
      { status: 200 },
    )
  },
}
