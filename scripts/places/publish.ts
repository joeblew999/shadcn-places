/**
 * Publish the database where ODbL can reach it, which is not git.
 *
 * `data/*.ndjson.gz` was committed because share-alike obliges us to make the
 * derived database available and a commit is provably available. That reasoning
 * was sound and the mechanism was wrong.
 *
 * Measured: `.git` is 134MB and mostly twelve copies of `cities.ndjson.gz`. gzip
 * is already compressed so git cannot delta it — every publish stores a fresh
 * 13.4MB, permanently. Weekly that is 0.7GB a year; on the day this was measured
 * it was fourteen publishes and 188MB. This repository has already had to
 * `git-filter-repo` a 76MB blob out of its history once.
 *
 * **ODbL says "make available". It does not say "in git."** A stable URL
 * discharges it completely, and it does so *better*: the obligation becomes
 * something the service tests can verify rather than something the README claims.
 *
 * ## What stays in git
 *
 * `data/manifest.json` — filenames, byte counts, SHA-256, and when. About 500
 * bytes, changes meaningfully, and diffs as text. It is the record of exactly
 * what was published, so a checkout can prove the bytes it downloads are the
 * bytes this commit vouched for.
 *
 * That is the split: git keeps the *claim*, R2 keeps the *bytes*.
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join, resolve as resolvePath } from "node:path"

const ROOT = resolvePath(import.meta.dirname, "../..")
const OUT = resolvePath(ROOT, process.env.PLACES_OUT ?? ".build")
const DATA = process.env.PLACES_DATA ?? join(ROOT, "data")
const BUCKET = process.env.PLACES_BUCKET ?? "shadcn-places-archive"

/** Where the published database lives in R2, and therefore at `/data/<name>`. */
const R2_PREFIX = "published"

export const TIERS = ["countries", "subdivisions", "cities"] as const

export interface PublishedFile {
  name: string
  bytes: number
  sha256: string
}

export interface Manifest {
  /** When these bytes were published. */
  at: string
  /** The commit they were built from, when there is one. */
  sha?: string
  /** Where to fetch them. Recorded so a consumer needs nothing but this file. */
  url: string
  licence: "ODbL-1.0"
  notice: string
  files: PublishedFile[]
}

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex")

export const manifestPath = () => join(DATA, "manifest.json")

export function readManifest(): Manifest | null {
  const path = manifestPath()
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Manifest) : null
}

function head(): string | undefined {
  const res = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" })
  return res.status === 0 ? res.stdout.trim() : undefined
}

function upload(local: string, key: string): void {
  /**
   * `--remote`, spelled out.
   *
   * Without it `wrangler r2 object put` writes to local miniflare storage and
   * reports success. That cost an hour once already: the Workflow said the write
   * had happened, the CLI said the key was missing, and both were telling the
   * truth about different buckets.
   */
  const res = spawnSync(
    "bun",
    ["x", "wrangler", "r2", "object", "put", `${BUCKET}/${key}`, `--file=${local}`, "--remote", "--content-type=application/gzip"],
    { cwd: ROOT, encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] },
  )
  if (res.status !== 0) {
    console.error(res.stdout ?? "", res.stderr ?? "")
    throw new Error(`uploading ${key} failed`)
  }
}

export async function publish(argv: string[]): Promise<void> {
  const dry = argv.includes("--dry-run")
  const base = process.env.PLACES_URL ?? "https://shadcn-places.gedw99.workers.dev"

  const files: PublishedFile[] = []
  const staged: { local: string; key: string }[] = []

  for (const tier of TIERS) {
    const local = join(OUT, `${tier}.ndjson.gz`)
    if (!existsSync(local)) {
      throw new Error(`${local} is missing — run \`places sync\`, which gzips the merged files first`)
    }
    const bytes = readFileSync(local)
    files.push({ name: `${tier}.ndjson.gz`, bytes: bytes.length, sha256: sha256(bytes) })
    staged.push({ local, key: `${R2_PREFIX}/${tier}.ndjson.gz` })
  }

  // History goes up too. It is small, it is the provenance of everything else,
  // and leaving it in git while the data leaves would be an odd half-measure.
  const history = join(DATA, "history.ndjson.gz")
  if (existsSync(history)) {
    const bytes = readFileSync(history)
    files.push({ name: "history.ndjson.gz", bytes: bytes.length, sha256: sha256(bytes) })
    staged.push({ local: history, key: `${R2_PREFIX}/history.ndjson.gz` })
  }

  const manifest: Manifest = {
    at: new Date().toISOString(),
    sha: head(),
    url: `${base}/data/`,
    licence: "ODbL-1.0",
    notice:
      "Place data from GeoNames (CC BY 4.0), dr5hn/countries-states-cities-database (ODbL-1.0), " +
      "OpenStreetMap contributors (ODbL-1.0), Wikidata (CC0) and Unicode CLDR. " +
      "Redistributing this database triggers ODbL share-alike. See LICENSE-DATA.",
    files,
  }

  const total = files.reduce((n, f) => n + f.bytes, 0)
  console.log(`  ${files.length} files, ${(total / 1048576).toFixed(1)}MB`)
  for (const f of files) console.log(`    ${f.name.padEnd(24)} ${(f.bytes / 1048576).toFixed(2).padStart(7)}MB  ${f.sha256.slice(0, 16)}…`)

  if (dry) {
    console.log(`\n  --dry-run: nothing uploaded. Would publish to ${manifest.url}`)
    return
  }

  for (const { local, key } of staged) {
    process.stdout.write(`  → ${key} `)
    upload(local, key)
    console.log(`${(statSync(local).size / 1048576).toFixed(1)}MB`)
  }

  writeFileSync(manifestPath(), JSON.stringify(manifest, null, 2) + "\n")
  console.log(`\n  manifest → data/manifest.json (${JSON.stringify(manifest).length} bytes, committed)`)
  console.log(`  bytes    → ${manifest.url} (R2, not committed)`)
  console.log(`\n  git keeps the claim; R2 keeps the bytes. Every publish used to add`)
  console.log(`  ${(total / 1048576).toFixed(1)}MB to git history permanently, and gzip cannot be delta-compressed.`)
}
