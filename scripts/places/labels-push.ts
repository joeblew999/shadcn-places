/**
 * Put the label work somewhere other than one laptop.
 *
 * `.build/labels/` holds 145MB across 95 files — about 1.76 million name rows,
 * every Wikidata pass and the OpenStreetMap city matching. It is gitignored,
 * correctly: it is derived, and 145MB of gzip-resistant NDJSON in git history is
 * the mistake that already cost this repository a `git-filter-repo`.
 *
 * But "not in git" was quietly doing the work of "not anywhere". The Cloudflare
 * build came out 623,000 names short of production, and the difference is exactly
 * this directory — which means the deployed database's provenance lived on one
 * disk, with no copy, behind a `.gitignore`.
 *
 * R2 is where derived-but-expensive belongs. `places pull` already reads
 * `labels/` from the same bucket, so this is the other half of a round trip that
 * only ever went one way.
 */

import { readdirSync, statSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join, resolve as resolvePath } from "node:path"

const ROOT = resolvePath(import.meta.dirname, "../..")
const OUT = resolvePath(ROOT, process.env.PLACES_OUT ?? ".build")
const BUCKET = process.env.PLACES_BUCKET ?? "shadcn-places-archive"

export async function labelsPush(argv: string[]): Promise<void> {
  const dir = join(OUT, "labels")
  const dry = argv.includes("--dry-run")
  const force = argv.includes("--force")

  let files: string[]
  try {
    /**
     * Not the ones that came from R2 in the first place.
     *
     * `places pull` writes what it downloads as `r2-<key>`, so pushing those back
     * would store each one a second time under a new name — the bucket growing
     * with every round trip, and `places pull` then fetching both copies.
     */
    files = readdirSync(dir).filter((f) => f.endsWith(".ndjson") && !f.startsWith("r2-"))
  } catch {
    console.error(`  no ${dir} — nothing to push`)
    process.exitCode = 1
    return
  }

  /**
   * Keyed by name, under a prefix the puller already reads.
   *
   * `labels/` is where the refresh Workflow writes and where `places pull` looks.
   * Using the same prefix means the two halves meet without either knowing about
   * the other — and re-pushing a file replaces itself rather than accumulating.
   */
  /**
   * The single-file form too, which the merge reads and this did not push.
   *
   * `loadLabels()` reads `.build/labels/*` **and** `.build/city-labels.ndjson`
   * and `.build/subdivision-labels.ndjson` — the shape the first version of the
   * label pass wrote, kept so an older build still folds in.
   *
   * Missing them left the Cloudflare build 94,526 names short of production after
   * everything else matched, which is a small enough number to look like rounding
   * and is 15MB of real work. A backup that covers most of a directory is a
   * backup nobody can rely on.
   */
  const legacy: { local: string; key: string }[] = []
  for (const tier of ["city", "subdivision"]) {
    const local = join(OUT, `${tier}-labels.ndjson`)
    try {
      statSync(local)
      legacy.push({ local, key: `labels/${tier}-labels.ndjson` })
    } catch {
      // Absent is fine: a build that never ran the first version of the pass.
    }
  }

  const total =
    files.reduce((n, f) => n + statSync(join(dir, f)).size, 0) +
    legacy.reduce((n, f) => n + statSync(f.local).size, 0)
  console.log(`  ${files.length + legacy.length} files, ${(total / 1048576).toFixed(0)}MB → r2://${BUCKET}/labels/`)

  if (dry) {
    for (const f of files.slice(0, 5)) console.log(`    ${f} ${(statSync(join(dir, f)).size / 1024).toFixed(0)}KB`)
    if (files.length > 5) console.log(`    …and ${files.length - 5} more`)
    console.log("\n  --dry-run: nothing uploaded.")
    return
  }

  const work = [
    ...files.map((f) => ({ local: join(dir, f), key: `labels/${f}` })),
    ...legacy,
  ]

  let pushed = 0
  let skipped = 0
  for (const [i, item] of work.entries()) {
    const local = item.local
    const key = item.key
    /**
     * Skipped if R2 already has it at the same size.
     *
     * These files are named by a hash of the locale set they cover, so a name
     * collision with a different size means the set was re-fetched and the new
     * one wins. Same size means the same run, and re-uploading 145MB to discover
     * that is not worth the bandwidth.
     */
    if (!force) {
      const head = spawnSync("bun", ["x", "wrangler", "r2", "object", "get", `${BUCKET}/${key}`, "--remote", "--pipe"], {
        cwd: ROOT, encoding: "buffer", maxBuffer: 256 * 1024 * 1024,
      })
      if (head.status === 0 && head.stdout && head.stdout.length === statSync(local).size) {
        skipped++
        continue
      }
    }
    const res = spawnSync(
      "bun",
      ["x", "wrangler", "r2", "object", "put", `${BUCKET}/${key}`, `--file=${local}`, "--remote", "--content-type=application/x-ndjson"],
      { cwd: ROOT, encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] },
    )
    if (res.status !== 0) {
      console.error(res.stdout ?? "", res.stderr ?? "")
      throw new Error(`uploading ${key} failed`)
    }
    pushed++
    process.stdout.write(`\r  ${i + 1}/${work.length} — ${pushed} pushed, ${skipped} already there   `)
  }
  console.log(`\n  ${pushed} uploaded, ${skipped} already present`)
  console.log(`  \`places pull\` reads the same prefix, so a fresh clone can now rebuild without this laptop.`)
}
