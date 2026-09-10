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
    let cityPlaces = 0
    let cityNames = 0
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

          /**
           * The label work: Wikidata's passes and the OpenStreetMap city matching.
           *
           * This is where most of the names are. The build without it came out
           * 622,999 short of production — GeoNames' own alternate names are the
           * inventory's floor, not its coverage, and everything that makes a Thai
           * reader see Thai comes from these files.
           *
           * Not partitioned at write time like the staged names, because they are
           * written by a different process — the refresh Workflow, and whatever
           * `places labels` last pushed — which has no reason to know how the
           * merge slices. So each partition reads them all and keeps its share.
           * 145MB read ten times is the cost of that independence, and it is
           * bounded per step, which is what the memory limit actually cares about.
           */
          const labels = await this.env.ARCHIVE.list({ prefix: "labels/", limit: 1000 })
          for (const object of labels.objects) {
            for await (const line of linesOf(this.env.ARCHIVE, object.key)) {
              const row = JSON.parse(line) as {
                placeId?: string
                geonameId?: string
                locale: string
                value: string
                source?: string
              }
              // `placeId` is the current field; `geonameId` is what the first
              // version of the city pass wrote, and a run from before that change
              // should still fold in rather than being silently ignored.
              const id = row.placeId ?? (row.geonameId ? `city:${row.geonameId}` : "")
              if (!id || partitionOf(id) !== part) continue
              const list = wanted.get(id) ?? []
              // The source travels with the row: OSM and Wikidata both land here
              // and an attribution line has to tell them apart.
              list.push({ locale: row.locale, value: row.value, source: row.source ?? "wikidata", kind: "translated" })
              wanted.set(id, list)
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
      cityPlaces += done.places
      cityNames += done.names
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
      smallTiers[tier] = await step.do(`merge the ${tier}`, { timeout: "10 minutes" }, async () => {
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

        /**
         * These tiers need the label work too, and the first version forgot them.
         *
         * The label reading lived inside the city partition loop only, so
         * countries came out with 14,649 names against production's 46,269 and
         * subdivisions with 212,486 against 236,558 — a 55,692 shortfall that was
         * entirely here while every city number matched.
         *
         * Countries feel like the tier that needs no help, because CLDR covers
         * them. It covers the hundred-odd locales ICU ships; the Wikidata pass
         * that took Wu and Cantonese from zero to 98% is in these files.
         *
         * Filtered by id prefix rather than partition: these tiers are not
         * partitioned, so the whole label set is scanned and everything belonging
         * to another tier is dropped as it goes past.
         */
        const prefix = tier === "countries" ? "country:" : "subdivision:"
        const labels = await this.env.ARCHIVE.list({ prefix: "labels/", limit: 1000 })
        for (const object of labels.objects) {
          for await (const line of linesOf(this.env.ARCHIVE, object.key)) {
            const row = JSON.parse(line) as {
              placeId?: string
              geonameId?: string
              locale: string
              value: string
              source?: string
            }
            const id = row.placeId ?? (row.geonameId ? `city:${row.geonameId}` : "")
            if (!id.startsWith(prefix)) continue
            const list = extra.get(id) ?? []
            list.push({ locale: row.locale, value: row.value, source: row.source ?? "wikidata", kind: "translated" })
            extra.set(id, list)
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
    /**
     * The SQL, streamed to R2 rather than assembled in memory.
     *
     * The first version pushed every statement into an array and wrote it at the
     * end. That is fine for 34,135 cities and 22MB, and it died on the real
     * inventory — `Worker exceeded memory limit`, twice, with the retries
     * behaving exactly as designed and failing exactly as fast.
     *
     * The same mistake as the merge: I bounded the step that obviously needed
     * bounding and left the one next to it holding the whole result. 69,700
     * places and 1.36 million names is around 80MB of SQL text, and a 128MB
     * isolate does not hold 80MB of JavaScript string.
     *
     * R2 multipart is the shape that fits — parts of at least 5MB, uploaded as
     * they fill, completed at the end. Memory is bounded by one part regardless
     * of how large the database grows.
     */
    const sql = await step.do(
      "write the load",
      { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "15 minutes" },
      async () => {
        const upload = await this.env.ARCHIVE.createMultipartUpload(key.sql)
        const uploaded: R2UploadedPart[] = []
        const encoder = new TextEncoder()

        /**
         * Exactly this many bytes per part, and the arithmetic is not optional.
         *
         * R2 rejects a completed upload whose parts differ in size:
         *
         *   completeMultipartUpload: All non-trailing parts must have the
         *   same length. (10048)
         *
         * The first version flushed whenever the buffer passed a threshold, so
         * every part was a slightly different size and the upload failed at
         * `complete` — after all the work, with the parts already stored. So this
         * accumulates bytes and emits exact slices, carrying the remainder.
         *
         * 8MB: R2's minimum for a non-trailing part is 5MB, and ten parts of a
         * 80MB load is a reasonable number of round trips.
         */
        const PART_BYTES = 8 * 1024 * 1024
        let pending: Uint8Array[] = []
        let pendingBytes = 0
        let total = 0

        const emit = async (bytes: Uint8Array) => {
          uploaded.push(await upload.uploadPart(uploaded.length + 1, bytes))
        }

        const write = async (text: string, final = false) => {
          if (text) {
            const encoded = encoder.encode(text)
            pending.push(encoded)
            pendingBytes += encoded.length
            total += encoded.length
          }
          while (pendingBytes >= PART_BYTES) {
            const joined = new Uint8Array(pendingBytes)
            let at = 0
            for (const chunk of pending) { joined.set(chunk, at); at += chunk.length }
            await emit(joined.subarray(0, PART_BYTES))
            const rest = joined.subarray(PART_BYTES)
            pending = rest.length ? [rest.slice()] : []
            pendingBytes = rest.length
          }
          if (!final || !pendingBytes) return
          // The trailing part is the one allowed to be short.
          const joined = new Uint8Array(pendingBytes)
          let at = 0
          for (const chunk of pending) { joined.set(chunk, at); at += chunk.length }
          pending = []
          pendingBytes = 0
          await emit(joined)
        }

        try {
          await write("-- Generated by the BuildDatabase Workflow. Data licence: ODbL-1.0.\n")
          await write("DELETE FROM coverage;\nDELETE FROM name;\nDELETE FROM place;\n\n")

          const everyMergedFile = [
            ...["countries", "subdivisions"].map((t) => key.mergedTier(t)),
            ...Array.from({ length: partitions }, (_, i) => key.merged(i)),
          ]

          /**
           * Every place before any name, in two passes.
           *
           * `name.place_id` references `place.id`. Batching both in one pass emits
           * a name batch whenever it fills, which can be before the batch holding
           * its place — D1 rejects the whole file with `FOREIGN KEY constraint
           * failed` and names no row. `PRAGMA foreign_keys=OFF` would silence it
           * and would be the wrong fix: the constraint was right and the order
           * was wrong.
           */
          let rows: string[] = []
          const flush = async (table: string, columns: string) => {
            if (!rows.length) return
            await write(`INSERT INTO ${table} (${columns}) VALUES\n${rows.join(",\n")};\n`)
            rows = []
          }

          const PLACE_COLUMNS = "id,type,pivot,parent_id,country_code,lat,lon,population,wikidata_id"
          for (const file of everyMergedFile) {
            for await (const line of linesOf(this.env.ARCHIVE, file)) {
              const p = JSON.parse(line) as MergedPlace
              rows.push(
                `(${q(p.id)},${q(p.type)},${q(p.pivot)},${s(p.parent)},${s(p.country)},${n(p.lat)},${n(p.lon)},${n(p.population)},${s(p.wikidata)})`,
              )
              if (rows.length >= 500) await flush("place", PLACE_COLUMNS)
            }
          }
          await flush("place", PLACE_COLUMNS)

          const NAME_COLUMNS = "place_id,locale,value,source,kind"
          for (const file of everyMergedFile) {
            for await (const line of linesOf(this.env.ARCHIVE, file)) {
              const p = JSON.parse(line) as MergedPlace
              for (const nm of p.names) {
                rows.push(`(${q(p.id)},${q(nm.locale)},${q(nm.value)},${q(nm.source)},${q(nm.kind)})`)
              }
              if (rows.length >= 500) await flush("name", NAME_COLUMNS)
            }
          }
          await flush("name", NAME_COLUMNS)

          await write(`
INSERT INTO coverage (locale, type, named, real)
SELECT n.locale, p.type, COUNT(*),
       SUM(CASE WHEN n.kind IN ('translated','native','override') THEN 1 ELSE 0 END)
  FROM name n JOIN place p ON p.id = n.place_id
 WHERE n.locale != 'und'
 GROUP BY n.locale, p.type;
`)
          await write("", true)
          await upload.complete(uploaded)
          return { bytes: total, parts: uploaded.length }
        } catch (error) {
          // An abandoned multipart upload keeps its parts and is billed for them.
          await upload.abort().catch(() => {})
          throw error
        }
      },
    )

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
    const safety = await step.do("check this build does not lose anything", async () => {
      /**
       * Per tier, because a total hides a regression inside it.
       *
       * This counted totals and would have passed a build that was 1,041 names
       * ahead overall and 449 country names behind — richer cities paying for
       * poorer countries, with every number the gate checked going up. That is
       * the same blind spot as counting places and not names, one level down.
       */
      const rows = await this.env.DB.prepare(
        `SELECT p.type,
                COUNT(DISTINCT p.id) places,
                COUNT(n.place_id) names
           FROM place p LEFT JOIN name n ON n.place_id = p.id
          GROUP BY p.type`,
      ).all<{ type: string; places: number; names: number }>()
      return Object.fromEntries(rows.results.map((r) => [r.type, { places: r.places, names: r.names }]))
    })

    /**
     * Names as well as places, and the second half was learned the hard way.
     *
     * The first version of this gate counted places only. The Cloudflare build
     * then came out with **more** places than production — 75,266 against 75,261,
     * because GeoNames had grown — and **623,000 fewer names**, because this
     * Workflow does not yet do the Wikidata label passes or the OpenStreetMap
     * city matching. The gate would have waved it through, the load would have
     * run its `DELETE FROM name`, and the database would have lost nearly half
     * its names while every count the gate checked went *up*.
     *
     * A gate that measures one dimension of a replacement is a gate that
     * guarantees nothing about the other one.
     */
    /**
     * What this build holds, per tier, to compare against what the database does.
     *
     * The city partitions are summed because they are one tier split ten ways;
     * countries and subdivisions merged whole and report themselves.
     */
    const built: Record<string, { places: number; names: number }> = {
      country: smallTiers.countries,
      subdivision: smallTiers.subdivisions,
      city: { places: cityPlaces, names: cityNames },
    }

    const losses: string[] = []
    for (const [tier, before] of Object.entries(safety)) {
      const after = built[tier]
      if (!after) {
        losses.push(`every ${tier} — this build has none and the database has ${before.places.toLocaleString()}`)
        continue
      }
      if (after.places < before.places) {
        losses.push(`${(before.places - after.places).toLocaleString()} ${tier} places (${before.places.toLocaleString()} → ${after.places.toLocaleString()})`)
      }
      if (after.names < before.names) {
        losses.push(`${(before.names - after.names).toLocaleString()} ${tier} names (${before.names.toLocaleString()} → ${after.names.toLocaleString()})`)
      }
    }
    if (losses.length && !event.payload?.force) {
      throw new Error(
        `STOPPING: importing this build would destroy ${losses.join(", ")}. ` +
          `The load opens with DELETE FROM place and DELETE FROM name, so an import replaces everything.\n` +
          `A country shortfall is expected and explainable: workerd's ICU carries 57 of the 76 CLDR ` +
          `locales this service snapshots, so 19 languages cannot be generated here at all, and ` +
          `Wikidata does not have every country in every one of them. Push a country snapshot from a ` +
          `runtime with fuller ICU, or accept the difference with { force: true }.`,
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
