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

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
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

/**
 * Whether we are pointed at a deployment rather than a dev server.
 *
 * `wrangler dev` uses *local* R2, and the published database is uploaded with
 * `--remote`. So a handful of properties here — the ODbL artefacts being
 * downloadable, and the registry item matching what is committed — are only
 * meaningful against a deployment: locally the bucket is empty and the answers
 * are correct and uninformative.
 *
 * Stated as a flag rather than left to fail, because a test that fails for the
 * wrong reason gets skipped for the wrong reason. `places sync` runs this file
 * against production after every deploy, which is where these execute.
 */
const deployed = up && Boolean(process.env.PLACES_URL)
if (up && !deployed) {
  console.warn("  (local dev: skipping the checks that need the deployed R2 bucket — set PLACES_URL to run them)")
}


describe("the service answers", () => {
  it.skipIf(!up)("serves the demo at the root", async () => {
    const res = await fetch(BASE)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toMatch(/html/)
  })

  for (const name of ["places-picker", "places-coverage"]) {
    it.skipIf(!up)(`serves ${name} at the URL the README tells people to use`, async () => {
      // The one URL a stranger tries first. It 404'd for an afternoon because the
      // asset binding serves from the root and the /r/ prefix was not stripped.
      const res = await fetch(`${BASE}/r/${name}.json`)
      expect(res.status, `/r/${name}.json is not served`).toBe(200)
      const item = (await res.json()) as { name: string; files: { content: string; target: string }[] }
      expect(item.name).toBe(name)
      expect(item.files.length).toBeGreaterThan(0)
      for (const f of item.files) {
        expect(f.content?.length, "a served file has no content — the installer cannot write it").toBeGreaterThan(100)
        expect(f.target, "a served file has no target — the installer will not know where to put it").toBeTruthy()
      }
    })

    it.skipIf(!up)(`serves the ${name} that is in this repository`, async () => {
      /**
       * The staleness check, and it only means something against a deployment.
       *
       * Registry items are static assets. `places sync` regenerates them and they
       * then exist only on the machine that ran it — the deployed
       * `/r/${name}.json` keeps serving the previous component and `shadcn add`
       * keeps installing it, with nothing failing anywhere. This project has
       * shipped that bug once already.
       *
       * Against localhost this is close to tautological, because the asset binding
       * reads the same `public/` directory the generator writes. Against
       * PLACES_URL it is the only thing that can tell you the deployed registry
       * has fallen behind the source, which is why `places sync` now ends by
       * deploying and then running this file against production.
       */
      const served = (await (await fetch(`${BASE}/r/${name}.json`)).json()) as {
        files: { path: string; content: string }[]
      }
      const local = JSON.parse(
        readFileSync(resolve(import.meta.dirname, "../..", "public", `${name}.json`), "utf8"),
      ) as { files: { path: string; content: string }[] }

      expect(served.files.map((f) => f.path)).toEqual(local.files.map((f) => f.path))
      for (const [i, f] of served.files.entries()) {
        expect(
          f.content,
          `the deployed ${name} is not the one in this repository — run \`bun x wrangler deploy\`, ` +
            `or \`bun run places sync\`, which now does`,
        ).toBe(local.files[i].content)
      }
    })
  }

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

describe("the database this service is obliged to publish", () => {
  /**
   * ODbL share-alike, made testable instead of asserted.
   *
   * dr5hn and OpenStreetMap are ODbL-1.0. Serving an API built on them is fine;
   * distributing the derived database obliges us to make that database available
   * under ODbL too, and publishing the ETL that would produce it does not
   * discharge that — the obligation is on the data.
   *
   * It used to be discharged by committing `data/*.ndjson.gz`, which was provable
   * and cost 13.4MB of git history per publish, permanently, because gzip cannot
   * be delta-compressed. `.git` reached 134MB and was mostly twelve copies of one
   * file.
   *
   * ODbL says *make available*. It does not say *in git*. Moving the bytes to a
   * URL is the better discharge precisely because of this block: a commit could
   * only be asserted, and a URL can be checked on every deploy.
   */
  it.skipIf(!deployed)("serves an index that names the licence and the sources", async () => {
    const res = await fetch(`${BASE}/data/`)
    expect(res.status, "/data/ is not served — the ODbL artefacts are unreachable").toBe(200)
    const index = (await res.json()) as {
      licence: string
      notice: string
      files: { name: string; bytes: number; url: string }[]
    }
    expect(index.licence).toBe("ODbL-1.0")
    expect(index.notice).toMatch(/OpenStreetMap/)
    expect(index.notice).toMatch(/share-alike/i)
    for (const tier of ["countries", "subdivisions", "cities"]) {
      const file = index.files.find((f) => f.name === `${tier}.ndjson.gz`)
      expect(file, `${tier} is not published`).toBeDefined()
      expect(file!.bytes).toBeGreaterThan(1000)
    }
  })

  it.skipIf(!deployed)("serves bytes that match the committed manifest", async () => {
    /**
     * The check that makes the split safe.
     *
     * `data/manifest.json` is committed and the bytes are not. That is only sound
     * if the two are verified against each other — otherwise the repository
     * records a claim about a database nobody can confirm, which is worse than
     * the 134MB it replaced.
     *
     * Countries only: it is 0.4MB, and downloading eleven megabytes on every
     * service-test run to prove the same property is a cost with no extra
     * information in it.
     */
    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../..", "data", "manifest.json"), "utf8"),
    ) as { files: { name: string; sha256: string }[] }
    const entry = manifest.files.find((f) => f.name === "countries.ndjson.gz")!

    const res = await fetch(`${BASE}/data/countries.ndjson.gz`)
    expect(res.status).toBe(200)
    expect(res.headers.get("x-licence"), "the credit must travel with the bytes").toBe("ODbL-1.0")
    expect(res.headers.get("x-attribution")).toMatch(/OpenStreetMap/)

    const bytes = new Uint8Array(await res.arrayBuffer())
    const digest = createHash("sha256").update(bytes).digest("hex")
    expect(
      digest,
      "the published database does not match data/manifest.json — either it was " +
        "republished without a commit, or the commit vouches for bytes nobody is serving",
    ).toBe(entry.sha256)
  })

  it.skipIf(!deployed)("refuses to serve anything outside the published prefix", async () => {
    /**
     * The R2 bucket also holds the refresh's staged sources and its run reports.
     * A key built from a path segment is how "serve one prefix" becomes "read the
     * bucket".
     *
     * Percent-encoded, because that is the form that actually reaches the
     * handler. A literal `../` is normalised away by the URL parser before the
     * Worker sees it — the first version of this test used one, passed nothing
     * meaningful, and would have gone on passing with the guard deleted.
     */
    for (const attempt of ["..%2Fstage%2Fmanifest.json", "%2E%2E%2Fstage%2Fcity-ids.txt", "stage%2Fmanifest.json"]) {
      const res = await fetch(`${BASE}/data/${attempt}`)
      expect(res.status, `${attempt} was not refused`).toBe(404)
      const body = await res.text()
      expect(body, `${attempt} returned bucket contents`).not.toMatch(/nameLinesScanned|geonames/)
    }
  })

  it.skipIf(!deployed)("does not serve the staging area as if it were published data", async () => {
    // `/data/../stage/x` normalises to `/stage/x`, which never reaches the R2
    // handler at all. Worth asserting anyway: what it must never do is return
    // something a caller could mistake for the database.
    const res = await fetch(`${BASE}/stage/manifest.json`)
    const body = await res.text()
    expect(body, "the staging manifest is readable over HTTP").not.toMatch(/nameLinesScanned/)
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

describe("English is the pivot, and every endpoint agrees about that", () => {
  /**
   * One fact — the pivot is the English name — answered three ways.
   *
   * `/api/matrix` and `/api/locales` special-cased `en` to 100%.
   * `/api/coverage/en` reported `named 100%, translated 0%`. And
   * `/api/countries?locale=en` returned `romanised` for all 257, because the
   * merge demotes any value equal to the pivot and for English that is every row.
   *
   * Nothing failed. It surfaced only when the demo stopped defaulting to Japanese
   * and an English reader saw the "nobody translated this" marker on every country
   * in the list. A service that contradicts itself about its own most common
   * language is one nobody can quote.
   */
  it.skipIf(!up)("never calls an English name a fallback", async () => {
    const { places } = (await (await api("/countries?locale=en")).json()) as {
      places: { name: string; kind: string }[]
    }
    expect(places.length).toBeGreaterThan(200)
    const fallbacks = places.filter((p) => p.kind === "romanised")
    expect(
      fallbacks.length,
      `${fallbacks.length} of ${places.length} English country names are marked romanised — ` +
        `the pivot is the English name, so a reader is told nothing is translated when everything is`,
    ).toBe(0)
  })

  it.skipIf(!up)("does the same for a region variant", async () => {
    // `en-AU` is what a browser sends, and it negotiates to `en`. If the special
    // case were tag-exact it would be right for `en` and wrong for every reader.
    const { places } = (await (await api("/countries?locale=en-AU")).json()) as { places: { kind: string }[] }
    expect(places.filter((p) => p.kind === "romanised").length).toBe(0)
  })

  it.skipIf(!up)("reports English as complete, in the endpoint that reports coverage", async () => {
    const cov = (await (await api("/coverage/en")).json()) as {
      tiers: { type: string; total: number; named: number; translated: number }[]
    }
    for (const tier of cov.tiers) {
      expect(tier.named, `${tier.type}: named should equal the total for English`).toBe(tier.total)
      expect(tier.translated, `${tier.type}: translated should equal the total for English`).toBe(tier.total)
    }
  })

  it.skipIf(!up)("never ranks English as a gap", async () => {
    // The matrix drops anything at 70% or better, so a complete language must not
    // appear at all. If it does, the three views have drifted apart again.
    const { gaps } = (await (await api("/matrix?limit=100")).json()) as { gaps: { locale: string }[] }
    expect(gaps.map((g) => g.locale)).not.toContain("en")
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

  it.skipIf(!up)("ranks gaps by the number a reader of that language would experience", async () => {
    /**
     * The matrix and `/coverage/{locale}` must not disagree about the same language.
     *
     * They did, for every Latin-script locale. The matrix counted `translated` —
     * romanised fallbacks excluded — for everything, so Spanish cities read 14%
     * while `/coverage/es` said `named` 51% and `latinScript: true`, which is
     * the endpoint telling you to read the 51%.
     *
     * That is not two views of one truth. It made Spanish the second largest gap
     * in the world, and `gapLocales()` in refresh.ts picks the weekly SPARQL
     * budget off this ranking — so the self-improving half of this service was
     * aiming at languages whose fallback already reads correctly.
     */
    const { gaps } = (await (await api("/matrix?limit=12")).json()) as {
      gaps: { locale: string; tier: string; coverage: number }[]
    }
    for (const gap of gaps) {
      const cov = (await (await api(`/coverage/${gap.locale}`)).json()) as {
        latinScript: boolean
        tiers: { type: string; total: number; named: number; translated: number }[]
      }
      const tier = cov.tiers.find((t) => t.type === gap.tier)
      expect(tier, `${gap.locale}/${gap.tier} is ranked but has no coverage row`).toBeDefined()
      const meaningful = cov.latinScript ? tier!.named : tier!.translated
      expect(
        gap.coverage,
        `${gap.locale} (${gap.tier}) is ranked at ${gap.coverage}% but /coverage/${gap.locale} reports ` +
          `${Math.round((meaningful / tier!.total) * 100)}% as the figure to read for a ${cov.latinScript ? "Latin" : "non-Latin"}-script language`,
      ).toBe(Math.round((meaningful / tier!.total) * 100))
    }
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
