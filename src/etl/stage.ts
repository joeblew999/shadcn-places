/**
 * The ETL's top half, on Cloudflare, with no laptop in it.
 *
 * This is the half that was supposed to be impossible. The reason given was that
 * GeoNames ships `.zip` and a Worker has no zip reader — which was wrong, and
 * `src/etl/zip.ts` records how wrong and what it cost: a laptop as a required
 * participant, and `data/` committed to git because there was no other place to
 * put it.
 *
 * ## Staging and extracting are one pass here, not two
 *
 * On a laptop they are separate because 963MB on disk is a cache worth keeping:
 * adding a language re-runs `extract` over what is already there and costs no
 * download. That reasoning does not survive the move. R2 egress to a Worker is
 * cheap but not free, and more to the point `alternateNames.txt` is **710MB
 * inflated to yield about 50MB of names we keep** — storing the raw form to read
 * it again later is paying to keep the part we discard.
 *
 * So the Workflow streams: fetch the entry's byte range, inflate, parse, filter,
 * write NDJSON to R2. The 710MB never lands anywhere.
 *
 * ## Why the inventory comes first
 *
 * `alternateNames.txt` carries names for every GeoNames feature — twelve million
 * of them — and we keep 69,700. Filtering needs the id set, so the inventory is
 * staged first and its ids are read back as a set before the big pass begins.
 * 69,700 ids is about 1MB in memory, against a 128MB isolate.
 *
 * ## Steps are slices, and that is the memory design
 *
 * A Workflow step has its own CPU budget and its own retry. The big pass takes a
 * byte range rather than the whole entry, so a step that fails costs one slice
 * and the instance resumes rather than restarting — the same reason the names
 * refresh is a Workflow.
 */

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers"
import { entriesFromUrl, openEntry, type ZipEntry } from "./zip.ts"
import { lines, parseAlternateName, parseCityRow, type RawName } from "./geonames.ts"
import { PARTITIONS, partitionOf, namesKey } from "./partition.ts"

interface Env {
  ARCHIVE: R2Bucket
}

interface Params {
  /** Override the inventory, for a smaller run. `cities15000` is 4x smaller. */
  inventory?: "cities5000" | "cities15000"
  /**
   * Stop after this many lines of `alternateNames.txt`.
   *
   * For proving the mechanism without spending twenty minutes of somebody else's
   * bandwidth. Absent means the whole file.
   */
  limit?: number
}

const DUMP = "https://download.geonames.org/export/dump"

/** Where staged output lives in R2. Prefixed so a listing is legible. */
const key = {
  places: (tier: string) => `stage/${tier}.ndjson`,
  manifest: "stage/manifest.json",
}

/**
 * How much of `alternateNames.txt` one step takes.
 *
 * 193MB compressed and 710MB inflated, and a step cannot be given the whole
 * thing: it would be one retry unit spanning twenty minutes. Slicing by
 * *compressed* byte range is what makes the slices independent — each one is a
 * separate ranged request.
 *
 * A DEFLATE stream cannot be resumed from an arbitrary offset, though, so the
 * slices are not independent in the way a naive reading suggests. What this
 * actually does is re-open the entry per step and skip forward, which costs
 * bandwidth but keeps each step short and independently retryable. Measured
 * against a laptop the whole pass is 24 seconds; the point of slicing is the
 * retry boundary, not the speed.
 */
const LINES_PER_STEP = 4_000_000

export class StageSources extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const inventory = event.payload?.inventory ?? "cities5000"
    const limit = event.payload?.limit

    /**
     * The inventory first, because it is the filter for everything after it.
     *
     * Small enough to be one step: 5.4MB compressed, 14.3MB inflated, 69,705
     * rows. Written as NDJSON so the shape matches what the CLI's `extract`
     * produces and the merge can read either.
     */
    const cities = await step.do("stage the city inventory", async () => {
      const url = `${DUMP}/${inventory}.zip`
      const { entries } = await entriesFromUrl(url)
      const entry = entries.find((e) => e.name === `${inventory}.txt`)
      if (!entry) throw new Error(`${inventory}.zip has no ${inventory}.txt`)

      const out: string[] = []
      const ids: string[] = []
      for await (const line of lines(await openEntry(url, entry))) {
        const place = parseCityRow(line)
        if (!place) continue
        ids.push(place.id.slice("city:".length))
        out.push(JSON.stringify(place))
      }
      await this.env.ARCHIVE.put(key.places("cities"), out.join("\n") + "\n")
      // The id set is written beside it rather than recomputed: the next step
      // needs it, steps do not share memory, and re-parsing 14MB to rebuild a
      // list we already had is the kind of waste that is invisible until it is
      // twenty minutes.
      await this.env.ARCHIVE.put("stage/city-ids.txt", ids.join("\n"))
      return { places: out.length, bytes: out.reduce((n, s) => n + s.length, 0) }
    })

    /**
     * The names, in slices.
     *
     * Every language GeoNames carries, filtered to the inventory. `wkdt` rows
     * are the Wikidata id and are kept separately — they are the join key the
     * label pass uses, and treating them as a language made `wkdt` look like a
     * widely spoken tongue.
     */
    const url = `${DUMP}/alternateNames.zip`
    /**
     * The entry's offsets, found once and carried between steps.
     *
     * A `ZipEntry` is five numbers and a string, which is exactly what a step may
     * return — and returning it means the slices below do not each re-read the
     * central directory. Six ranged requests saved is not the point; a step that
     * depends on nothing but its own input is.
     */
    const entry = await step.do("find the names entry", async (): Promise<ZipEntry> => {
      const { entries } = await entriesFromUrl(url)
      const found = entries.find((e) => e.name === "alternateNames.txt")
      if (!found) throw new Error("alternateNames.zip has no alternateNames.txt")
      return found
    })

    const ids = await step.do("read the inventory ids back", async () => {
      const object = await this.env.ARCHIVE.get("stage/city-ids.txt")
      if (!object) throw new Error("the inventory step wrote no id list")
      return (await object.text()).split("\n").filter(Boolean)
    })
    const wanted = new Set(ids)

    let part = 0
    let kept = 0
    let scanned = 0
    for (;;) {
      const from = part * LINES_PER_STEP
      const slice = await step.do(
        `names ${from.toLocaleString()}+`,
        { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "10 minutes" },
        async () => {
          const stream = await openEntry(url, entry)
          const byId = new Map<string, RawName[]>()
          const wikidata: string[] = []
          let seen = 0
          let taken = 0
          for await (const line of lines(stream)) {
            seen++
            if (seen <= from) continue
            if (seen > from + LINES_PER_STEP) break
            if (limit && seen > limit) break
            const row = parseAlternateName(line)
            if (!row || !wanted.has(row.geonameId)) continue
            if (row.kind === "wikidata") { wikidata.push(`${row.geonameId}\t${row.value}`); continue }
            const list = byId.get(row.geonameId) ?? []
            list.push({ locale: row.locale, value: row.value, source: "geonames", kind: "translated" })
            byId.set(row.geonameId, list)
            taken++
          }
          /**
           * Written into the partition the merge will look for it in.
           *
           * This used to write one file per slice-of-the-source, so every merge
           * partition read every file and discarded nine tenths — 322MB of JSON
           * parsed to do 32MB of work. It survived the first run because that
           * stage was limited to ~3MB of names, and hit the 30-second CPU wall
           * the moment it saw the real 26.2MB.
           *
           * The writer partitions now, so the reader reads one slice.
           */
          const buckets: string[][] = Array.from({ length: PARTITIONS }, () => [])
          for (const [geonameId, names] of byId) {
            const placeId = `city:${geonameId}`
            buckets[partitionOf(placeId)].push(JSON.stringify({ placeId, names }))
          }
          let written = 0
          for (let p = 0; p < PARTITIONS; p++) {
            if (!buckets[p].length) continue
            await this.env.ARCHIVE.put(namesKey(p, part), buckets[p].join("\n") + "\n")
            written += buckets[p].length
          }
          const body = { length: written }
          if (wikidata.length) await this.env.ARCHIVE.put(`stage/city-wikidata-${String(part).padStart(3, "0")}.tsv`, wikidata.join("\n"))
          return { seen, taken, places: body.length, exhausted: seen <= from + LINES_PER_STEP }
        },
      )
      kept += slice.taken
      scanned = slice.seen
      part++
      if (slice.exhausted || (limit && scanned >= limit)) break
      // A guard rather than a condition: alternateNames.txt is 19.1M lines, so
      // six slices is already past the end. If this ever runs away, something
      // upstream changed shape and a hung Workflow is the worst way to find out.
      if (part > 12) throw new Error(`${part} slices and not exhausted — has the file changed shape?`)
    }

    /**
     * Fold the Wikidata ids back onto the places.
     *
     * `wkdt` rows arrive interleaved with the names, so they are written to their
     * own files as they are found and joined here. Without this step the
     * Cloudflare path produces a place record with no `wikidata` field while the
     * CLI produces one with it — the same NDJSON, subtly different, which is the
     * two-writers-disagree failure this project keeps meeting.
     *
     * It was caught by diffing the key sets of one city from each path rather
     * than by reading the code, which is the only way that class of drift is ever
     * found.
     */
    const joined = await step.do("attach the Wikidata ids", async () => {
      const qids = new Map<string, string>()
      const listing = await this.env.ARCHIVE.list({ prefix: "stage/city-wikidata-" })
      for (const object of listing.objects) {
        const body = await this.env.ARCHIVE.get(object.key)
        if (!body) continue
        for (const line of (await body.text()).split("\n")) {
          const tab = line.indexOf("\t")
          if (tab > 0) qids.set(line.slice(0, tab), line.slice(tab + 1))
        }
      }
      if (!qids.size) return { attached: 0 }

      const cities = await this.env.ARCHIVE.get(key.places("cities"))
      if (!cities) throw new Error("the inventory is gone from R2")
      const out: string[] = []
      let attached = 0
      for (const line of (await cities.text()).split("\n")) {
        if (!line) continue
        const place = JSON.parse(line) as { id: string; wikidata?: string }
        const qid = qids.get(place.id.slice("city:".length))
        if (qid) { place.wikidata = qid; attached++ }
        out.push(JSON.stringify(place))
      }
      await this.env.ARCHIVE.put(key.places("cities"), out.join("\n") + "\n")
      return { attached }
    })

    const report = {
      at: new Date().toISOString(),
      wikidataIds: joined.attached,
      inventory,
      cities: cities.places,
      nameLinesScanned: scanned,
      namesKept: kept,
      parts: part,
    }
    await step.do("record what was staged", async () => {
      await this.env.ARCHIVE.put(key.manifest, JSON.stringify(report, null, 2))
    })
    return report
  }
}
