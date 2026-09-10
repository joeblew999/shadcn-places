/**
 * Tests against the running service, because every bug so far got through here.
 *
 * The repo checks are static — licences, registry shape, data invariants — and
 * all 39 of them passed while the service returned 500 for every subdivision
 * request, refused every browser, and answered a query-string `limit` with a
 * validation error. Each was found by a person opening the page.
 *
 * The pattern in those three: they were failures of the *edges* — the wire
 * format, the headers, the transport — and nothing that only reads source can see
 * an edge. So this makes requests.
 *
 * Points at the local dev server by default and at the deployed one with
 * PLACES_URL, because both need to be true and they have disagreed: remote D1
 * refuses transactions local D1 accepts, and the asset binding behaves
 * differently under `wrangler dev`.
 */

import { describe, it, expect } from "vitest"

const BASE = process.env.PLACES_URL ?? "http://localhost:8787"
const api = (path: string) => fetch(`${BASE}/api${path}`)

/**
 * Probed at module load, not in `beforeAll`.
 *
 * `it.skipIf(cond)` reads `cond` when the file is *collected*, which happens
 * before any hook runs. With the probe in `beforeAll` every test in this file
 * skipped and the suite reported "39 passed | 16 skipped" — green, and testing
 * nothing. A test that cannot fail is worse than no test, because it is counted.
 *
 * Top-level await runs during collection, so the value is real by the time
 * `skipIf` reads it.
 */
const up = await fetch(BASE, { signal: AbortSignal.timeout(4000) })
  .then((r) => r.ok)
  .catch(() => false)
if (!up) console.warn(`\n  no service at ${BASE} — these tests need: bun x wrangler dev --port 8787\n`)


describe("the service answers", () => {
  it.skipIf(!up)("serves the demo at the root", async () => {
    const res = await fetch(BASE)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toMatch(/html/)
  })

  it.skipIf(!up)("serves the registry item at the URL the README tells people to use", async () => {
    // The one URL a stranger tries first. It 404'd for an afternoon because the
    // asset binding serves from the root and the /r/ prefix was not stripped.
    const res = await fetch(`${BASE}/r/places-picker.json`)
    expect(res.status).toBe(200)
    const item = (await res.json()) as { name: string; files: unknown[] }
    expect(item.name).toBe("places-picker")
    expect(item.files.length).toBeGreaterThan(0)
  })

  it.skipIf(!up)("lets a browser call it", async () => {
    // No CORS headers at all until somebody opened the demo on localhost and got
    // an empty dropdown. A public read-only API a browser cannot call is a public
    // API for servers.
    const res = await api("/countries?locale=en")
    expect(res.headers.get("access-control-allow-origin")).toBe("*")
  })

  it.skipIf(!up)("answers a preflight", async () => {
    const res = await fetch(`${BASE}/api/countries`, { method: "OPTIONS" })
    expect(res.status).toBeLessThan(300)
    expect(res.headers.get("access-control-allow-origin")).toBe("*")
  })
})

describe("the cascade", () => {
  it.skipIf(!up)("returns every country, in the reader's language", async () => {
    const { places } = (await (await api("/countries?locale=ja")).json()) as { places: { name: string; kind: string }[] }
    expect(places.length).toBeGreaterThan(200)
    // Japanese is complete at this tier; if it is not, something upstream broke.
    const japanese = places.filter((p) => p.kind === "translated")
    expect(japanese.length / places.length).toBeGreaterThan(0.95)
    expect(places.some((p) => /[ぁ-んァ-ヶ一-龠]/.test(p.name))).toBe(true)
  })

  it.skipIf(!up)("names no country twice", async () => {
    // Deprecated ISO aliases put Germany in the list twice and Serbia three
    // times. Invisible in JSON, obvious in a dropdown.
    const { places } = (await (await api("/countries?locale=en")).json()) as { places: { name: string }[] }
    const names = places.map((p) => p.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it.skipIf(!up)("returns a country's subdivisions", async () => {
    const { places } = (await (await api("/subdivisions?country=TH&locale=th")).json()) as {
      places: { name: string; kind: string }[]
    }
    expect(places.length).toBe(78)
    const thai = places.filter((p) => /[฀-๿]/.test(p.name))
    expect(thai.length).toBeGreaterThan(70)
  })

  it.skipIf(!up)("puts real translations before fallbacks", async () => {
    // Ordering by the resolved name alone put every Latin fallback above every
    // Thai one, because Latin sorts lower. The data was right and the order
    // buried it below the fold.
    const { places } = (await (await api("/subdivisions?country=TH&locale=th")).json()) as {
      places: { kind: string }[]
    }
    const firstFallback = places.findIndex((p) => p.kind === "romanised")
    const lastReal = places.map((p) => p.kind).lastIndexOf("translated")
    if (firstFallback >= 0) expect(firstFallback).toBeGreaterThan(lastReal - 1)
  })

  it.skipIf(!up)("searches cities by prefix, scoped to a country", async () => {
    const { places } = (await (await api("/cities?country=TH&q=chi&locale=th&limit=5")).json()) as {
      places: { name: string; population: number | null }[]
    }
    expect(places.length).toBeGreaterThan(0)
    expect(places.length).toBeLessThanOrEqual(5)
  })

  it.skipIf(!up)("accepts limit from a query string", async () => {
    // `limit` arrives as the string "3". The RPC transport sends real numbers, so
    // this failed only over HTTP — the half a stranger uses first.
    const res = await api("/cities?country=BR&q=sao&locale=pt&limit=3")
    expect(res.status).toBe(200)
    const { places } = (await res.json()) as { places: unknown[] }
    expect(places.length).toBeLessThanOrEqual(3)
  })

  it.skipIf(!up)("refuses a city search with no country", async () => {
    // The scoping is what keeps a keystroke from scanning 69,700 rows. If this
    // ever succeeds, the contract has been loosened and the bill follows.
    //
    // It was already refused — there is no such route — but the response was 200
    // with the service's own root document, so a mistyped path parsed as success.
    // Asserting the status found that; asserting only "no places" would not have.
    const res = await api("/nope?q=paris")
    expect(res.status).toBe(404)
    const body = (await res.json()) as { places?: unknown[]; error?: string }
    expect(body.places).toBeUndefined()
    expect(body.error).toBeTruthy()
  })

  it.skipIf(!up)("says what the endpoints are when a path is wrong", async () => {
    // A 404 that lists the alternatives costs nothing and saves a round trip
    // through documentation for anyone integrating.
    const { endpoints } = (await (await api("/nonsense")).json()) as { endpoints: string[] }
    expect(endpoints.some((e) => e.includes("/countries"))).toBe(true)
  })

  it.skipIf(!up)("never returns an empty name", async () => {
    // The promise the pivot exists to keep: ask in a language with almost nothing
    // and still get something renderable.
    const { places } = (await (await api("/subdivisions?country=BR&locale=yue")).json()) as {
      places: { name: string }[]
    }
    expect(places.length).toBeGreaterThan(0)
    for (const p of places) expect(p.name.trim()).toBeTruthy()
  })
})

describe("the URLs it published this morning", () => {
  /**
   * Every method moved when oRPC 2.0 made RESTful paths possible again.
   *
   * `@orpc/openapi` 1.15 could not generate a spec for any route with a dynamic
   * path parameter, so the whole API was flat query strings. 2.0 fixes it, the
   * paths came back — and `/api/subdivisions?country=TH` started answering 404
   * while `contract.ts` still said, in a comment, that it kept working.
   *
   * A comment is not a compatibility guarantee. This is.
   */
  const legacy = [
    ["/subdivisions?country=TH&locale=th", "/api/countries/TH/subdivisions"],
    ["/cities?country=BR&q=sao&locale=pt&limit=3", "/api/countries/BR/cities"],
    ["/city?id=city:1609350&locale=th", "/api/cities/city%3A1609350"],
    ["/coverage?locale=th", "/api/coverage/th"],
  ] as const

  for (const [path, successor] of legacy) {
    it.skipIf(!up)(`still answers ${path.split("?")[0]}`, async () => {
      const res = await api(path)
      expect(res.status, `${path} 404s — code written against it is broken`).toBe(200)
      // Answered, and told it is legacy. RFC 8594: the caller who looks finds out,
      // the caller who does not keeps working.
      expect(res.headers.get("deprecation")).toBe("true")
      expect(res.headers.get("link")).toContain(successor)
      const body = (await res.json()) as { places?: unknown[]; place?: unknown; tiers?: unknown[] }
      expect(body.places ?? body.place ?? body.tiers, "answered 200 with nothing in it").toBeTruthy()
    })
  }

  it.skipIf(!up)("does not turn the old paths into a way around the country scoping", async () => {
    // The rewrite must not become the hole the scoping was closed against: no
    // country in the query means no path to rewrite to, so it stays a 404.
    const res = await api("/cities?q=paris")
    expect(res.status).toBe(404)
  })
})

describe("it says what it knows", () => {
  it.skipIf(!up)("reports coverage as two numbers and which to read", async () => {
    const th = (await (await api("/coverage?locale=th")).json()) as { latinScript: boolean; tiers: unknown[] }
    expect(th.latinScript).toBe(false)
    const vi = (await (await api("/coverage?locale=vi")).json()) as { latinScript: boolean }
    expect(vi.latinScript).toBe(true)
  })

  it.skipIf(!up)("ranks its own gaps by readers", async () => {
    const { gaps } = (await (await api("/matrix?limit=5")).json()) as {
      gaps: { locale: string; readers: number; missing: number }[]
    }
    expect(gaps.length).toBeGreaterThan(0)
    // Ranked, not arbitrary: each gap should cost at least as much as the next.
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i - 1].readers * gaps[i - 1].missing).toBeGreaterThanOrEqual(gaps[i].readers * gaps[i].missing)
    }
    // A variant is answered from its base, so it is not a separate work item.
    expect(gaps.every((g) => !g.locale.includes("-"))).toBe(true)
  })

  it.skipIf(!up)("offers languages named in their own language", async () => {
    const { locales } = (await (await api("/locales?min=70&tier=country")).json()) as {
      locales: { code: string; endonym: string }[]
    }
    const ja = locales.find((l) => l.code === "ja")
    expect(ja?.endonym).toBe("日本語")
    const th = locales.find((l) => l.code === "th")
    expect(th?.endonym).toBe("ไทย")
  })

  it.skipIf(!up)("credits the sources that require it", async () => {
    const { notice, sources } = (await (await api("/attribution")).json()) as {
      notice: string
      sources: { licence: string }[]
    }
    expect(notice).toMatch(/GeoNames/)
    expect(notice).toMatch(/ODbL/i)
    expect(sources.some((s) => s.licence === "CC BY 4.0")).toBe(true)
  })
})

describe("the typed client the README promises", () => {
  /**
   * It did not exist for a day.
   *
   * `import { createPlacesClient } from "shadcn-places/client"` was in the
   * quick-start with no `src/client.ts` and no `exports` field behind it — the
   * same failure as the registry item, one layer up: documented, never built,
   * never imported, nothing red.
   *
   * The pattern is now unmistakable. Three things this project told people to
   * use were broken in the same way, and each was found by a person trying it
   * rather than by a test. So the client is exercised here, against the running
   * service, over the RPC transport a consumer would actually use.
   */
  it.skipIf(!up)("lists countries over RPC, with types", async () => {
    const { createPlacesClient } = await import("../../src/client.ts")
    const places = createPlacesClient({ url: BASE })
    const { places: countries } = await places.countries.list({ locale: "ja" })
    expect(countries.length).toBeGreaterThan(200)
    expect(countries.some((c) => /[ぁ-んァ-ヶ一-龠]/.test(c.name))).toBe(true)
  })

  it.skipIf(!up)("accepts a custom fetch, which is how a service binding works", async () => {
    const { createPlacesClient } = await import("../../src/client.ts")
    let sawRequest = false
    const places = createPlacesClient({
      url: BASE,
      // env.PLACES.fetch has exactly this shape. If oRPC ever stops accepting a
      // custom fetch, every service-binding consumer breaks and this is the test
      // that says so.
      fetch: (request) => { sawRequest = true; return fetch(request) },
    })
    const { places: subs } = await places.subdivisions.list({ country: "TH", locale: "th" })
    expect(sawRequest, "the custom fetch was never called — service bindings would not work").toBe(true)
    expect(subs.length).toBe(78)
  })

  it.skipIf(!up)("serves a real OpenAPI document", async () => {
    // `/openapi.json` fell through to the service's root document and answered
    // 200 with something that is not a spec, while the README said one existed.
    const spec = (await (await fetch(`${BASE}/openapi.json`)).json()) as {
      openapi?: string
      paths?: Record<string, unknown>
    }
    expect(spec.openapi, "not an OpenAPI document").toMatch(/^3\./)
    expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThan(5)
  })
})
