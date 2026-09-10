/**
 * Fetch each source, unchanged, and record when.
 *
 * The only step that touches the network for bulk data, and the only expensive
 * one: a full stage is about 1.2GB. It is separate from `extract` for one reason
 * that decides whether this project stays alive — **adding a language must not
 * cost a download.** GeoNames' alternate names file already contains every
 * language on earth; a language we do not yet extract is already staged. So a new
 * language re-runs `extract` over what is on disk, in minutes.
 *
 * `--sample` stages the small files only, which is enough to build a working
 * database and is what CI and a first clone should use. The full stage is a
 * deliberate act.
 *
 * On Cloudflare this writes to R2 instead of a directory; the shape is the same,
 * which is why the destination is a parameter rather than an assumption.
 */

import { existsSync, mkdirSync, statSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { SOURCES } from "../lib/sources.ts"

const STAGE = process.env.PLACES_STAGE ?? ".stage"
const MANIFEST = join(STAGE, "manifest.json")

/** What is staged, and when. `extract` reads this to know what it may use. */
interface Manifest {
  [sourceId: string]: { file: string; bytes: number; fetchedAt: string; licence: string }
}

const read = (): Manifest => (existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : {})

async function fetchTo(url: string, path: string): Promise<number> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  // Streamed to disk rather than buffered: alternateNames.zip is 193MB and
  // `await res.arrayBuffer()` on that is most of an isolate's memory budget.
  const body = await res.arrayBuffer()
  writeFileSync(path, Buffer.from(body))
  return statSync(path).size
}

export async function stage(argv: string[]): Promise<void> {
  const sample = argv.includes("--sample")
  const only = argv.filter((a) => !a.startsWith("--"))
  mkdirSync(STAGE, { recursive: true })
  const manifest = read()

  const wanted = SOURCES.filter((s) => s.url)
    .filter((s) => (only.length ? only.includes(s.id) : true))
    // The alternates file is the 193MB one. A sample stage skips it and the
    // extract falls back to what the per-country archives carry.
    .filter((s) => !(sample && s.id === "geonames-alternates"))

  if (!wanted.length) {
    console.log("nothing to stage. Sources with a URL:", SOURCES.filter((s) => s.url).map((s) => s.id).join(", "))
    return
  }

  console.log(`staging ${wanted.length} source(s) into ${STAGE}/`)
  for (const s of wanted) console.log(`  ${s.id.padEnd(22)} ${s.weight.padEnd(30)} ${s.licence}`)
  console.log()

  for (const s of wanted) {
    const file = join(STAGE, `${s.id}${s.url!.endsWith(".zip") ? ".zip" : s.url!.endsWith(".json") ? ".json" : ".txt"}`)
    if (existsSync(file) && statSync(file).size > 0) {
      console.log(`  ${s.id}: already staged (${(statSync(file).size / 1048576).toFixed(1)}MB), skipping`)
      manifest[s.id] ??= { file, bytes: statSync(file).size, fetchedAt: "unknown", licence: s.licence }
      continue
    }
    process.stdout.write(`  ${s.id}: fetching … `)
    const bytes = await fetchTo(s.url!, file)
    console.log(`${(bytes / 1048576).toFixed(1)}MB`)
    manifest[s.id] = { file, bytes, fetchedAt: new Date().toISOString(), licence: s.licence }
  }

  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n")
  console.log(`\nstaged. ${MANIFEST} records what is here and when it was fetched.`)
  console.log("Nothing after this step touches the network, except Wikidata's label queries.")
}
