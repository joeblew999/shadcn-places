/**
 * The refresh: the service improving itself, on a schedule, with nobody watching.
 *
 * Everything in this database is currently current because somebody ran the ETL
 * by hand today. GeoNames changes daily and Wikidata continuously, so without
 * this the whole thing is a snapshot that quietly ages — and a places service
 * that was right last year is a places service that is wrong.
 *
 * ## What runs here and what cannot
 *
 * Not the whole pipeline — and the boundary is a decision, not a fact, which is
 * a correction. This used to read: *"GeoNames ships `.zip` archives and a Worker
 * has `DecompressionStream` for gzip and deflate but no zip reader. That step
 * stays a CLI job."*
 *
 * Both halves of that were wrong, and it shaped the architecture — it is why a
 * laptop is a required participant and why `data/` went into git.
 *
 *   `node:zlib` is fully supported in Workers and this Worker already runs
 *   `nodejs_compat`. A zip entry is a raw DEFLATE stream behind a local header,
 *   so `createInflateRaw` reads it. Proved end to end against a real GeoNames
 *   archive in `wrangler dev`: 97,846 zip bytes in, an entry inflated out.
 *
 *   D1's bulk load is not CLI-only either. `POST /d1/database/{id}/import` takes
 *   `init-upload` → `upload_url` → `ingest` → poll, which is plain HTTP.
 *
 * What is actually left is engineering rather than impossibility: a 128MB isolate
 * against a 744MB `alternateNames.txt` means every step owns a slice and hands
 * state to the next.
 *
 * It turns out to be the right seam anyway. The two halves change at completely
 * different rates:
 *
 *   **which places exist** — GeoNames, dr5hn. Changes slowly. A new town is rare.
 *   **what they are called** — Wikidata, OSM. Changes continuously, because
 *   somebody adds a Thai name to a Polish town every day of the week.
 *
 * So the inventory is rebuilt occasionally by hand, and the names refresh
 * themselves weekly. That is also the half that moves coverage.
 *
 * ## Why a Workflow rather than a cron Worker
 *
 * Because it will fail partway. Wikidata rate-limits, Overpass returns 429, a
 * batch times out — all of which happened while building this. A Workflow step
 * retries independently and the instance resumes rather than restarting, so a
 * refresh that stumbles on batch 200 of 279 does not re-fetch the first 199.
 *
 * A plain cron Worker would also hit the 15-minute CPU ceiling; steps have their
 * own budget each.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"

interface Env {
  DB: D1Database
  /** Where a run's findings are staged before they touch the database. */
  ARCHIVE: R2Bucket
}

interface Params {
  /**
   * Which languages to refresh. Empty means "ask the coverage table" — the loop
   * running itself, which is the entire point of the schedule.
   */
  locales?: string[]
  /** Cities per SPARQL query. Small enough to come back, large enough to finish. */
  batch?: number
}

const ENDPOINT = "https://query.wikidata.org/sparql"

/**
 * The languages worth spending a refresh on, chosen by the data.
 *
 * Reads the same coverage table `/api/matrix` ranks from: languages that are
 * strong in one tier and weak in another, ordered by how many readers that
 * affects. A language nobody reads and a language we have never had are both
 * excluded — the first is not worth the queries, the second is not a gap but an
 * absence we do not claim to have filled.
 *
 * ## Non-Latin scripts only, and that is the whole point
 *
 * This counted `real` — names excluding the romanised fallbacks — for every
 * language, which meant Spanish looked like the second worst gap in the world.
 * It is not: Spanish cities are `named` 51% and `translated` 14%, and the
 * difference is names identical to the English pivot, which for Spanish are
 * usually right. São Paulo is São Paulo in Spanish.
 *
 * So a rate-limited weekly budget of SPARQL queries was being aimed at
 * languages whose fallback already reads correctly, and away from Hindi,
 * Bengali and Arabic, where a Latin string is simply unreadable. Restricting
 * this to non-Latin scripts is not a refinement of the ranking; it is the
 * difference between the refresh doing something and doing nothing.
 *
 * Latin-script languages are not abandoned — they are just not what *this*
 * fixes. Their gaps are diacritics and exonyms, which come from OSM and dr5hn
 * through the ETL rather than from asking Wikidata for a label that will come
 * back as the English string again.
 */
async function gapLocales(env: Env, limit = 12): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT locale,
            MAX(CASE WHEN type = 'city' THEN real ELSE 0 END)         AS city,
            MAX(CASE WHEN type = 'subdivision' THEN real ELSE 0 END)  AS sub
       FROM coverage
      WHERE locale NOT LIKE '%-%' AND locale != 'und' AND latin = 0
      GROUP BY locale
      HAVING sub > 2000 AND city < 40000
      ORDER BY city ASC
      LIMIT ?`,
  )
    .bind(limit)
    .all<{ locale: string }>()
  return results.map((r) => r.locale)
}

/**
 * POSTed, because the query carries hundreds of ids and a URL cannot.
 *
 * The first version put it in the query string and Wikidata answered **431,
 * Request Header Fields Too Large**, four times, before the step gave up. The
 * local CLI does the same thing and works only because its batch is 250 rather
 * than 500 — it was one size bump away from the same failure and nobody would
 * have connected the two.
 *
 * SPARQL over POST is the documented form for anything non-trivial, and it has no
 * length ceiling worth thinking about.
 */
async function sparql(query: string): Promise<Record<string, { value: string }>[] | null> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      accept: "application/sparql-results+json",
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "shadcn-places/0.1 (https://github.com/joeblew999/shadcn-places) scheduled refresh",
    },
    body: new URLSearchParams({ query }),
    signal: AbortSignal.timeout(90_000),
  })
  // Thrown, not swallowed: the step retries, and a rate-limited request must never
  // become "this place has no name in that language".
  if (!res.ok) throw new Error(`wikidata ${res.status}`)
  const body = (await res.json()) as { results: { bindings: Record<string, { value: string }>[] } }
  return body.results.bindings
}

export class RefreshNames extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const batchSize = event.payload?.batch ?? 400

    const locales = await step.do("choose the languages", async () => {
      const chosen = event.payload?.locales?.length
        ? event.payload.locales
        : await gapLocales(this.env)
      if (!chosen.length) throw new Error("no gap languages found — is the coverage table populated?")
      return chosen
    })

    /**
     * The cities to ask about, oldest gap first.
     *
     * Only places with no real name in *any* of the chosen languages: a city
     * already named in all of them cannot be improved by asking again, and the
     * whole cost here is the asking.
     */
    const targets = await step.do("find the cities still missing a name", async () => {
      const placeholders = locales.map(() => "?").join(",")
      const { results } = await this.env.DB.prepare(
        `SELECT p.id id FROM place p
          WHERE p.type = 'city'
            AND NOT EXISTS (
              SELECT 1 FROM name n
               WHERE n.place_id = p.id
                 AND n.locale IN (${placeholders})
                 AND n.kind IN ('translated','native','override')
            )
          LIMIT 20000`,
      )
        .bind(...locales)
        .all<{ id: string }>()
      return results.map((r) => r.id.replace("city:", ""))
    })

    if (!targets.length) {
      return { locales, checked: 0, added: 0, note: "nothing missing in these languages" }
    }

    const langFilter = locales.map((l) => `"${l}"`).join(", ")
    let added = 0

    /**
     * One step per batch, so a failure costs one batch.
     *
     * Steps are the unit of retry and of resumption. Doing the whole fetch in a
     * single step would mean a rate-limit at ninety percent throws all of it away,
     * which is precisely what a Workflow exists to prevent.
     */
    for (let i = 0; i < targets.length; i += batchSize) {
      const slice = targets.slice(i, i + batchSize)
      const written = await step.do(
        `fetch and store ${i}-${i + slice.length}`,
        { retries: { limit: 4, delay: "20 seconds", backoff: "exponential" }, timeout: "5 minutes" },
        async () => {
          const values = slice.map((id) => `"${id}"`).join(" ")
          const rows = await sparql(`
            SELECT ?gid ?label WHERE {
              VALUES ?gid { ${values} }
              ?c wdt:P1566 ?gid .
              ?c rdfs:label ?label .
              FILTER(LANG(?label) IN (${langFilter}))
            }`)
          if (!rows?.length) return 0

          const found: { gid: string; locale: string; value: string }[] = []
          for (const r of rows) {
            const value = r.label?.value
            const locale = (r.label as unknown as { "xml:lang"?: string })?.["xml:lang"]
            const gid = r.gid?.value
            if (value && locale && gid) found.push({ gid, locale, value })
          }

          const statements = rows
            .map((r) => {
              const value = r.label?.value
              const locale = (r.label as unknown as { "xml:lang"?: string })?.["xml:lang"]
              const gid = r.gid?.value
              if (!value || !locale || !gid) return null
              /**
               * `INSERT OR IGNORE`, never REPLACE.
               *
               * An override or a better source may already hold this (place,
               * locale), and a scheduled job must not silently outrank a human.
               * The merge's precedence lives in the ETL; here the rule is simply
               * "fill a hole, never overwrite".
               */
              return this.env.DB.prepare(
                `INSERT OR IGNORE INTO name (place_id, locale, value, source, kind)
                 VALUES (?, ?, ?, 'wikidata', 'translated')`,
              ).bind(`city:${gid}`, locale, value)
            })
            .filter((s): s is D1PreparedStatement => s !== null)

          if (!statements.length) return 0
          await this.env.DB.batch(statements)

          /**
           * The same findings to R2, or this becomes a second source of truth.
           *
           * Measured before this existed: the deployed database held 8,221 Thai
           * names from Wikidata and the local build held 5,196. The Workflow had
           * found 3,025 that existed nowhere else — and `places load` opens with
           * `DELETE FROM name`, so the next local rebuild would have deleted every
           * one of them without a word.
           *
           * Writing them where the ETL can read them makes the refresh a
           * *contributor* to the pipeline rather than a fork of it. `places pull`
           * brings them down, the merge folds them in through the same precedence
           * as every other source, and a rebuild carries them forward instead of
           * undoing them.
           */
          const ndjson = found
            .map((f) => JSON.stringify({ placeId: `city:${f.gid}`, locale: f.locale, value: f.value, source: "wikidata" }))
            .join("\n")
          await this.env.ARCHIVE.put(`labels/refresh-${event.instanceId}-${i}.ndjson`, ndjson + "\n")

          return statements.length
        },
      )
      added += written
    }

    /**
     * Coverage is derived, so it is rebuilt rather than adjusted.
     *
     * Incrementing counters as rows are inserted would drift the first time a
     * batch is retried and half-applied. Recomputing costs one query on a table
     * this size and cannot be wrong.
     */
    await step.do("rebuild coverage", async () => {
      await this.env.DB.batch([
        this.env.DB.prepare(`DELETE FROM coverage`),
        this.env.DB.prepare(
          `INSERT INTO coverage (locale, type, named, real)
           SELECT n.locale, p.type, COUNT(*),
                  SUM(CASE WHEN n.kind IN ('translated','native','override') THEN 1 ELSE 0 END)
             FROM name n JOIN place p ON p.id = n.place_id
            WHERE n.locale != 'und'
            GROUP BY n.locale, p.type`,
        ),
      ])
    })

    /**
     * A record of the run, kept.
     *
     * Written to R2 rather than logged because the interesting question is asked
     * weeks later — "when did Thai coverage jump, and what did it" — and logs are
     * gone by then. It is also the only place a refresh that quietly found nothing
     * for six weeks would be visible.
     */
    const report = { at: new Date().toISOString(), locales, checked: targets.length, added }
    await step.do("record what happened", async () => {
      await this.env.ARCHIVE.put(`refresh/${report.at}.json`, JSON.stringify(report))

      /**
       * An index of the label files, because nothing can list the bucket.
       *
       * `wrangler r2 object` has get, put and delete and no list — so `places
       * pull` cannot discover what a run produced. It was written against a
       * command that does not exist and committed with tests that only checked
       * the file was there.
       *
       * The Workflow knows what it wrote, so it says so at a key the puller can
       * ask for by name. Rebuilt from the bucket's own listing — which the
       * *binding* has, even though the CLI does not — so a run that crashed
       * before this point still leaves its files discoverable by the next one.
       */
      const keys: string[] = []
      let cursor: string | undefined
      do {
        const page = await this.env.ARCHIVE.list({ prefix: "labels/", cursor, limit: 1000 })
        for (const o of page.objects) if (o.key.endsWith(".ndjson")) keys.push(o.key)
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor)
      await this.env.ARCHIVE.put("labels-index.json", JSON.stringify({ at: report.at, keys }))
    })

    return report
  }
}
