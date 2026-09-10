/**
 * Reading and writing without holding a dataset in memory.
 *
 * A Cloudflare isolate has 128 MB and the limit is not configurable, so
 * `JSON.parse` of dr5hn's 44MB export is out — the object graph is several times
 * the file. That constraint decides the shape of this whole pipeline, and it is
 * cheaper to obey from the first line than to retrofit: a streaming ETL runs in a
 * Workflow *or* on a laptop, while a `readFileSync` one only ever runs on the
 * laptop.
 *
 * These helpers exist so that no ETL step has to think about it again.
 */

import { createReadStream, createWriteStream, existsSync, mkdirSync } from "node:fs"
import { createInterface } from "node:readline"
import { dirname } from "node:path"

/** Yield a file's lines without loading it. Blank lines are skipped. */
export async function* lines(path: string): AsyncGenerator<string> {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  for await (const line of rl) if (line) yield line
}

/** Yield a tab-separated file's rows. Every GeoNames dump is this shape. */
export async function* tsv(path: string): AsyncGenerator<string[]> {
  for await (const line of lines(path)) yield line.split("\t")
}

/** Yield the objects of an NDJSON file, one at a time. */
export async function* records<T>(path: string): AsyncGenerator<T> {
  for await (const line of lines(path)) yield JSON.parse(line) as T
}

/**
 * Write NDJSON incrementally.
 *
 * Returns a `write`/`close` pair rather than taking an array, because taking an
 * array would mean the caller had already built one in memory and lost the point.
 */
export function ndjsonWriter(path: string): { write: (row: unknown) => void; close: () => Promise<number> } {
  mkdirSync(dirname(path), { recursive: true })
  const out = createWriteStream(path)
  let count = 0
  return {
    write(row) {
      count++
      out.write(JSON.stringify(row) + "\n")
    },
    close: () =>
      new Promise((resolve) => {
        out.end(() => resolve(count))
      }),
  }
}

/**
 * A large JSON array, streamed as objects.
 *
 * dr5hn ships one 44MB array rather than NDJSON, so it has to be walked by
 * bracket depth. Deliberately narrow: it handles an array of objects and nothing
 * else, which is what the sources actually are. A general JSON streaming parser
 * would be a dependency and a much larger surface for one file shape.
 *
 * String and escape state are tracked because a `{` inside a name — and there are
 * names with braces — would otherwise be read as structure.
 */
export async function* jsonArray<T>(path: string): AsyncGenerator<T> {
  const stream = createReadStream(path, { encoding: "utf8" })
  let buf = ""
  // Where scanning has already reached. Without this the scan restarts at 0 on
  // every chunk and re-applies the string toggles to text it has already read —
  // which silently mis-tracks whether it is inside a quoted string, so braces in
  // data are counted as structure. It parsed 56 of dr5hn's 5,308 rows before
  // this index existed, and reported success on all 56.
  let scanned = 0
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for await (const chunk of stream) {
    buf += chunk
    for (let i = scanned; i < buf.length; i++) {
      const c = buf[i]
      if (escaped) { escaped = false; continue }
      if (c === "\\") { escaped = true; continue }
      if (c === '"') { inString = !inString; continue }
      if (inString) continue
      if (c === "{") { if (depth === 0) start = i; depth++ }
      else if (c === "}") {
        depth--
        if (depth === 0 && start >= 0) {
          yield JSON.parse(buf.slice(start, i + 1)) as T
          // Drop what has been consumed so the buffer does not grow to the file.
          buf = buf.slice(i + 1)
          i = -1
          scanned = 0
          start = -1
        }
      }
    }
    scanned = buf.length
  }
}
