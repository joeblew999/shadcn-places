/**
 * Merge, load and publish — the ETL's bottom half, on Cloudflare.
 *
 * With `StageSources` above it, this closes the loop: sources to served database
 * with no laptop anywhere in it. What is left on a developer's machine is the
 * same pipeline, for when something has gone wrong and you want it in front of
 * you.
 *
 * ## Partitioned by id, because 128MB is the whole design constraint
 *
 * The merged cities file is 106MB and the names that feed it are tens of
 * megabytes more. Neither fits an isolate beside the other.
 *
 * So each step takes every city whose GeoNames id ends in a given digit —
 * `id % PARTITIONS === k` — and only the names for those cities. Memory is
 * bounded by `1/PARTITIONS` of the total regardless of how large the inventory
 * grows, and each step is an independent retry unit. Ten steps of ten megabytes
 * rather than one of a hundred.
 *
 * Partitioning by id rather than by country or by file offset is deliberate: it
 * is the only key that is stable across runs, evenly distributed, and knowable
 * without reading anything first.
 *
 * ## The decision is imported, never repeated
 *
 * `resolve()` comes from `src/etl/resolve.ts`, which is what the CLI calls too.
 * `merge` is the only step that decides anything — which name wins, whether `tl`
 * and `fil` are one language, whether a source's "translated" survives contact
 * with the script it is written in — and two implementations of that would be two
 * databases. This project has shipped that bug three times.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import { resolve, type Place, type Name, type MergedPlace, type Overrides } from "./resolve.ts"
import { importSql, type ImportOutcome } from "./d1-import.ts"
import { PARTITIONS, partitionOf, namesPrefix } from "./partition.ts"

interface Env {
  ARCHIVE: R2Bucket
  DB: D1Database
  /** D1:Edit. Only the bulk import needs it; the binding cannot do this. */
  CLOUDFLARE_API_TOKEN?: string
  CLOUDFLARE_ACCOUNT_ID?: string
  D1_DATABASE_ID?: string
}

interface Params {
  /** Skip the D1 import and stop after writing the merged output. */
  mergeOnly?: boolean
  /**
   * Import even though the build has fewer places than the database.
   *
   * The gate exists because this Workflow stages cities only and the load opens
   * with `DELETE FROM place`. Sometimes a smaller database is the fix; this is
   * how you say so.
   */
  force?: boolean
}

const key = {
  staged: "stage/cities.ndjson",
  tier: (t: string) => `stage/${t}.ndjson`,
  mergedTier: (t: string) => `build/${t}.merged.ndjson`,
  merged: (part: number) => `build/cities.merged-${part}.ndjson`,
  sql: "build/load.sql",
}

/** Read an R2 object as lines, without holding it. */
async function* linesOf(bucket: R2Bucket, objectKey: string): AsyncGenerator<string> {
  const object = await bucket.get(objectKey)
  if (!object) return
  const reader = object.body.getReader()
  const decoder = new TextDecoder()
  let rest = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const text = rest + decoder.decode(value, { stream: true })
    let start = 0
    for (;;) {
      const nl = text.indexOf("\n", start)
      if (nl < 0) break
      const line = text.slice(start, nl)
      if (line) yield line
      start = nl + 1
    }
    rest = text.slice(start)
  }
  if (rest.trim()) yield rest
}

/** SQLite string literal. Doubling the quote is the whole of the escaping. */
const q = (v: string) => `'${v.replace(/'/g, "''")}'`
const n = (v: number | null | undefined) =>
  v === undefined || v === null || Number.isNaN(v) ? "NULL" : String(v)
const s = (v: string | null | undefined) => (v === undefined || v === null || v === "" ? "NULL" : q(v))

export class BuildDatabase extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    /**
     * Fixed, because the stage baked it into the object keys.
     *
     * It used to be a parameter. A build that partitioned differently from the
     * stage would read `stage/names/p3/` while the names for partition 3 sat in
     * a layout that no longer matched — and would produce a database missing
     * most of its names, successfully.
     */
    const partitions = PARTITIONS

    /**
     * Overrides first, because they outrank everything and there are few of them.
     *
     * Read from R2 rather than the repository: a Worker has no checkout. Absent is
     * fine — the file is corrections we have made ourselves, and a deployment that
     * has none is not broken.
     */
    const overrides = await step.do("read the overrides", async (): Promise<Overrides> => {
      const object = await this.env.ARCHIVE.get("stage/overrides.json")
      if (!object) return {}
      const file = (await object.json()) as { names?: Overrides }
      return file.names ?? {}
    })

    let places = 0
    let names = 0
    for (let part = 0; part < partitions; part++) {
      const done = await step.do(
        `merge partition ${part}`,
        { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" },
        async () => {
          /**
           * The names for this partition only.
           *
           * Every staged name file is read, and everything outside this partition
           * is discarded as it goes past. That is the trade: `partitions` passes
           * over the name files in exchange for a bounded heap, and R2 reads
           * inside the same region are the cheap half of this pipeline.
           */
          const wanted = new Map<string, Name[]>()
          const listing = await this.env.ARCHIVE.list({ prefix: namesPrefix(part) })
          for (const object of listing.objects) {
            for await (const line of linesOf(this.env.ARCHIVE, object.key)) {
              const row = JSON.parse(line) as { placeId: string; names: Name[] }
              const list = wanted.get(row.placeId) ?? []
              list.push(...row.names)
              wanted.set(row.placeId, list)
            }
          }

          const out: string[] = []
          let merged = 0
          for await (const line of linesOf(this.env.ARCHIVE, key.staged)) {
            const place = JSON.parse(line) as Place
            if (partitionOf(place.id) !== part) continue
            const extra = wanted.get(place.id)
            if (extra) place.names = [...place.names, ...extra]
            const resolved: MergedPlace = { ...place, names: resolve(place, overrides) }
            merged += resolved.names.length
            out.push(JSON.stringify(resolved))
          }
          await this.env.ARCHIVE.put(key.merged(part), out.join("\n") + "\n")
          return { places: out.length, names: merged }
        },
      )
      places += done.places
      names += done.names
    }

    /**
     * Countries and subdivisions, whole rather than partitioned.
     *
     * 257 and 5,304 against 34,135 cities — small enough to merge in one step
     * each, and partitioning them would be ceremony. The names for subdivisions
     * came out of the same pass over `alternateNames.txt` that fed the cities, so
     * they are gathered here rather than re-read.
     */
    const smallTiers: Record<string, { places: number; names: number }> = {}
    for (const tier of ["countries", "subdivisions"]) {
      smallTiers[tier] = await step.do(`merge the ${tier}`, async () => {
        const extra = new Map<string, Name[]>()
        if (tier === "subdivisions") {
          const listing = await this.env.ARCHIVE.list({ prefix: "stage/subdivision-names-" })
          for (const object of listing.objects) {
            for await (const line of linesOf(this.env.ARCHIVE, object.key)) {
              const row = JSON.parse(line) as { placeId: string; names: Name[] }
              const list = extra.get(row.placeId) ?? []
              list.push(...row.names)
              extra.set(row.placeId, list)
            }
          }
        }
        const out: string[] = []
        let merged = 0
        const seen = new Set<string>()
        for await (const line of linesOf(this.env.ARCHIVE, key.tier(tier))) {
          const place = JSON.parse(line) as Place
          /**
           * First occurrence wins on a duplicate id.
           *
           * dr5hn lists four French overseas territories as both French
           * subdivisions and entries in their own right, so `subdivision:FR-973`
           * appears twice. D1 answers `UNIQUE constraint failed: place.id` and
           * names none of them.
           */
          if (seen.has(place.id)) continue
          seen.add(place.id)
          const more = extra.get(place.id)
          if (more) place.names = [...place.names, ...more]
          const resolved: MergedPlace = { ...place, names: resolve(place, overrides) }
          merged += resolved.names.length
          out.push(JSON.stringify(resolved))
        }
        await this.env.ARCHIVE.put(key.mergedTier(tier), out.join("\n") + "\n")
        return { places: out.length, names: merged }
      })
      places += smallTiers[tier].places
      names += smallTiers[tier].names
    }

    /**
     * The SQL, written once the merge is settled.
     *
     * A full load rather than a delta: a delta needs the previous publish to
     * compare against, and that comparison lives in `places diff` on the CLI side.
     * Doing it here would be a second implementation of the one thing that decides
     * what changed — so this Workflow writes a full load and the delta stays where
     * the diff is.
     */
    const sql = await step.do("write the load", async () => {
      const parts: string[] = [
        "-- Generated by the BuildDatabase Workflow. Data licence: ODbL-1.0.",
        "DELETE FROM coverage;",
        "DELETE FROM name;",
        "DELETE FROM place;",
        "",
      ]
      let placeRows: string[] = []
      let nameRows: string[] = []
      const flush = (table: string, columns: string, rows: string[]) => {
        if (!rows.length) return
        parts.push(`INSERT INTO ${table} (${columns}) VALUES\n${rows.join(",\n")};`)
        rows.length = 0
      }

      /**
       * Every place before any name, in two passes.
       *
       * `name.place_id` references `place.id`. Batching both in one pass emits a
       * name batch whenever it fills, which can be before the batch holding its
       * place — D1 rejects the whole file with `FOREIGN KEY constraint failed`
       * and names no row. `PRAGMA foreign_keys=OFF` would silence it and would be
       * the wrong fix: the constraint was right and the order was wrong.
       */
      const everyMergedFile = [
        ...["countries", "subdivisions"].map((t) => key.mergedTier(t)),
        ...Array.from({ length: partitions }, (_, i) => key.merged(i)),
      ]
      for (const file of everyMergedFile) {
        for await (const line of linesOf(this.env.ARCHIVE, file)) {
          const p = JSON.parse(line) as MergedPlace
          placeRows.push(
            `(${q(p.id)},${q(p.type)},${q(p.pivot)},${s(p.parent)},${s(p.country)},${n(p.lat)},${n(p.lon)},${n(p.population)},${s(p.wikidata)})`,
          )
          if (placeRows.length >= 500) flush("place", "id,type,pivot,parent_id,country_code,lat,lon,population,wikidata_id", placeRows)
        }
      }
      flush("place", "id,type,pivot,parent_id,country_code,lat,lon,population,wikidata_id", placeRows)

      for (const file of everyMergedFile) {
        for await (const line of linesOf(this.env.ARCHIVE, file)) {
          const p = JSON.parse(line) as MergedPlace
          for (const nm of p.names) {
            nameRows.push(`(${q(p.id)},${q(nm.locale)},${q(nm.value)},${q(nm.source)},${q(nm.kind)})`)
          }
          if (nameRows.length >= 500) flush("name", "place_id,locale,value,source,kind", nameRows)
        }
      }
      flush("name", "place_id,locale,value,source,kind", nameRows)

      parts.push(`
INSERT INTO coverage (locale, type, named, real)
SELECT n.locale, p.type, COUNT(*),
       SUM(CASE WHEN n.kind IN ('translated','native','override') THEN 1 ELSE 0 END)
  FROM name n JOIN place p ON p.id = n.place_id
 WHERE n.locale != 'und'
 GROUP BY n.locale, p.type;`)

      const body = parts.join("\n") + "\n"
      await this.env.ARCHIVE.put(key.sql, body)
      return { bytes: body.length }
    })

    if (event.payload?.mergeOnly) {
      return { places, names, sqlBytes: sql.bytes, imported: null }
    }

    /**
     * Into D1, over the import API.
     *
     * The binding cannot bulk-load: it has `batch()`, which is right for the
     * weekly refresh's few thousand rows and wrong for 1.36 million. The import
     * API is a four-step HTTP protocol and needs a D1:Edit token, which is the one
     * thing here the binding cannot substitute for.
     *
     * It blocks the database while it runs. That is Cloudflare's own warning and
     * it is why this is a deliberate act rather than something on a schedule.
     */
    /**
     * Refuse to import a build that would shrink the database.
     *
     * The load opens with `DELETE FROM place`, so an import replaces everything.
     * This Workflow stages **cities only** — countries and subdivisions still come
     * from the CLI — and running it against production would have deleted 257
     * countries, 5,304 subdivisions and 35,565 cities, along with every Wikidata
     * label and OpenStreetMap name folded in since.
     *
     * That was one command away from happening, with the merge already sitting in
     * R2 looking finished. `places sync` has had a loss gate since the day a
     * rebuild lost 23 places; the Workflow had nothing, because the CLI path was
     * the only one that could write.
     *
     * A shrinking database is sometimes correct — filtering the deprecated country
     * aliases removed 23 places and that was the fix — so this stops rather than
     * refuses, and `force` is how somebody says they meant it.
     */
    const safety = await step.do("check this build does not lose places", async () => {
      const before = await this.env.DB.prepare(
        `SELECT type, COUNT(*) n FROM place GROUP BY type`,
      ).all<{ type: string; n: number }>()
      const existing = new Map(before.results.map((r) => [r.type, r.n]))
      const total = [...existing.values()].reduce((a, b) => a + b, 0)
      return { existing: Object.fromEntries(existing), total, incoming: places }
    })

    if (!event.payload?.force && safety.incoming < safety.total) {
      const missing = Object.entries(safety.existing)
        .filter(([type]) => type !== "city")
        .map(([type, n]) => `${n} ${type}`)
        .join(", ")
      throw new Error(
        `STOPPING: this build has ${safety.incoming.toLocaleString()} places and the database has ` +
          `${safety.total.toLocaleString()}. The load opens with DELETE FROM place, so importing it would ` +
          `destroy ${missing} and ${(safety.total - safety.incoming).toLocaleString()} places in total. ` +
          `This Workflow stages cities only. Run with { force: true } if that is what you meant.`,
      )
    }

    const imported = await step.do(
      "import into D1",
      { retries: { limit: 2, delay: "30 seconds", backoff: "exponential" }, timeout: "15 minutes" },
      async (): Promise<ImportOutcome> => {
        const { CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID } = this.env
        if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID || !D1_DATABASE_ID) {
          throw new Error(
            "the D1 import needs CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and D1_DATABASE_ID. " +
              "Set them with `wrangler secret put`, or run with { mergeOnly: true }.",
          )
        }
        const object = await this.env.ARCHIVE.get(key.sql)
        if (!object) throw new Error("the load step wrote no SQL")
        return importSql(
          { accountId: CLOUDFLARE_ACCOUNT_ID, databaseId: D1_DATABASE_ID, apiToken: CLOUDFLARE_API_TOKEN },
          await object.text(),
          { onProgress: (m) => console.log("d1:", m) },
        )
      },
    )

    return { places, names, sqlBytes: sql.bytes, imported }
  }
}
