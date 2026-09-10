/**
 * What was last published, fetched from where it now lives.
 *
 * `diff` and `load` both need the previous release: `diff` to report what a
 * rebuild changes, `load` to write a delta rather than an 81MB full rewrite. Both
 * used to read `data/*.ndjson.gz` straight off disk, which worked because the
 * database was committed.
 *
 * It is not committed any more — 13.4MB per publish, permanently, because gzip
 * cannot be delta-compressed. The bytes live in R2 and `data/manifest.json`
 * records their SHA-256.
 *
 * ## Downloaded into `data/`, which is now a cache
 *
 * `data/` used to be committed and is gitignored now, which makes it exactly the
 * right place: `history` appends to `data/history.ndjson.gz` and `publish` reads
 * it back, so a separate cache directory would mean two locations for one file
 * and a `history` command that silently started from empty on a fresh clone.
 *
 * A rebuild against an unchanged release costs nothing after the first fetch, so
 * `diff` stays the fast local step it was.
 *
 * ## Verified, not trusted
 *
 * The manifest is committed and the bytes are not, which is only a safe split if
 * the two are checked against each other. A download whose SHA-256 does not match
 * the manifest is refused — not warned about — because the alternative is a diff
 * computed against bytes this commit never vouched for, reporting differences
 * that are not real and losses that are.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve as resolvePath } from "node:path"
import { readManifest, sha256, type Manifest } from "./publish.ts"

const ROOT = resolvePath(import.meta.dirname, "../..")
const DATA = process.env.PLACES_DATA ?? join(ROOT, "data")

/**
 * The bytes of a previously published file, or null if there is no such release.
 *
 * Null is a real answer and not an error: the first ever build has nothing to
 * compare against, and a fresh clone with no network should still be able to run
 * the pipeline and be told it is publishing for the first time.
 *
 * Purely a file read. `fetchBaseline` is the only part that touches the network,
 * because a function that might make an HTTP request is a different thing from
 * one that reads a file, and `diff` should not quietly become an online step.
 */
export function baseline(name: string): Uint8Array | null {
  const path = join(DATA, name)
  return existsSync(path) ? readFileSync(path) : null
}

/**
 * Make sure every file the manifest names is on disk, downloading what is not.
 *
 * `sync` calls this once, up front, so a run either has its baseline or fails
 * before it has written anything — rather than three steps later, halfway
 * through a load.
 */
export async function fetchBaseline(options: { quiet?: boolean; force?: boolean } = {}): Promise<Manifest | null> {
  const manifest = readManifest()
  if (!manifest) {
    if (!options.quiet) console.log("  no data/manifest.json — this build would be the first release")
    return null
  }
  mkdirSync(DATA, { recursive: true })

  for (const file of manifest.files) {
    const path = join(DATA, file.name)
    if (existsSync(path) && !options.force) {
      // Already here. Checked against the manifest rather than assumed, because a
      // half-written download from an interrupted run looks exactly like a good
      // one and would silently become the baseline.
      const have = sha256(readFileSync(path))
      if (have === file.sha256) continue
      if (!options.quiet) console.log(`  ${file.name} does not match the manifest — refetching`)
    }

    const url = `${manifest.url.replace(/\/$/, "")}/${file.name}`
    if (!options.quiet) process.stdout.write(`  fetching ${file.name} (${(file.bytes / 1048576).toFixed(1)}MB) `)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}. The manifest names a file the service does not serve.`)
    const bytes = new Uint8Array(await res.arrayBuffer())

    const got = sha256(bytes)
    if (got !== file.sha256) {
      /**
       * Refused rather than warned about.
       *
       * The manifest is committed and the bytes are not. That split is only safe
       * because this check exists — otherwise a diff runs against bytes no commit
       * vouched for, and reports changes that did not happen and losses that did.
       */
      throw new Error(
        `${file.name} does not match data/manifest.json\n` +
          `  manifest: ${file.sha256}\n` +
          `  download: ${got}\n` +
          `  Either the published database moved without a commit, or the download is corrupt.`,
      )
    }
    writeFileSync(path, bytes)
    if (!options.quiet) console.log("✓ verified")
  }
  return manifest
}
