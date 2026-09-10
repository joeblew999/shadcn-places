/**
 * The zip reader, against archives built here rather than fetched.
 *
 * This module exists because "a Worker cannot read a zip" was written into this
 * repository as a fact, shaped the whole architecture — a laptop in the pipeline,
 * `data/` committed to git — and was wrong.
 *
 * So the tests are about the container format, which is where the real hazards
 * are. A zip entry's data does not start where the central directory says the
 * entry is: that offset points at a *local* header of variable length, whose name
 * and extra fields need not match the central directory's. Get it wrong and the
 * stream inflates to garbage rather than failing.
 *
 * The network tests live in `tests/api/zip-live.test.ts` and are opt-in. These
 * run offline, in milliseconds, on every commit.
 */

import { gzipSync, deflateRawSync } from "node:zlib"
import { describe, it, expect } from "vitest"
import { parseCentralDirectory, dataOffset, inflate } from "../../src/etl/zip.ts"

/**
 * Build a zip in memory, with control over the parts that break readers.
 *
 * `extraInLocalHeader` is the whole reason this exists: real archives put
 * alignment or timestamp fields in the local header that are absent from the
 * central directory, so a reader that trusts one length for both reads from the
 * wrong offset.
 */
function buildZip(
  files: { name: string; content: Uint8Array; store?: boolean }[],
  opts: { extraInLocalHeader?: number; comment?: string } = {},
): Uint8Array {
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  const enc = new TextEncoder()

  for (const f of files) {
    const nameBytes = enc.encode(f.name)
    const body = f.store ? f.content : new Uint8Array(deflateRawSync(f.content))
    const extra = new Uint8Array(opts.extraInLocalHeader ?? 0)

    const local = new Uint8Array(30 + nameBytes.length + extra.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(8, f.store ? 0 : 8, true)
    lv.setUint32(18, body.length, true)
    lv.setUint32(22, f.content.length, true)
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, extra.length, true)
    local.set(nameBytes, 30)
    local.set(extra, 30 + nameBytes.length)

    const entry = new Uint8Array(46 + nameBytes.length)
    const ev = new DataView(entry.buffer)
    ev.setUint32(0, 0x02014b50, true)
    ev.setUint16(10, f.store ? 0 : 8, true)
    ev.setUint32(20, body.length, true)
    ev.setUint32(24, f.content.length, true)
    ev.setUint16(28, nameBytes.length, true)
    // Deliberately zero extra/comment length in the central directory even when
    // the local header has extra bytes. That mismatch is the hazard.
    ev.setUint32(42, offset, true)
    entry.set(nameBytes, 46)
    central.push(entry)

    chunks.push(local, body)
    offset += local.length + body.length
  }

  const cdStart = offset
  const cdBytes = central.reduce((n, c) => n + c.length, 0)
  const commentBytes = enc.encode(opts.comment ?? "")
  const eocd = new Uint8Array(22 + commentBytes.length)
  const dv = new DataView(eocd.buffer)
  dv.setUint32(0, 0x06054b50, true)
  dv.setUint16(8, files.length, true)
  dv.setUint16(10, files.length, true)
  dv.setUint32(12, cdBytes, true)
  dv.setUint32(16, cdStart, true)
  dv.setUint16(20, commentBytes.length, true)
  eocd.set(commentBytes, 22)

  const all = [...chunks, ...central, eocd]
  const total = all.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let p = 0
  for (const c of all) { out.set(c, p); p += c.length }
  return out
}

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({ start(c) { c.enqueue(bytes); c.close() } })

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const parts: Uint8Array[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return new TextDecoder().decode(
    parts.reduce((a, b) => {
      const out = new Uint8Array(a.length + b.length)
      out.set(a); out.set(b, a.length)
      return out
    }, new Uint8Array()),
  )
}

const text = (s: string) => new TextEncoder().encode(s)

describe("the zip central directory", () => {
  it("finds every entry", () => {
    const zip = buildZip([
      { name: "readme.txt", content: text("hello") },
      { name: "cities5000.txt", content: text("a\tb\tc") },
    ])
    const entries = parseCentralDirectory(zip)
    expect(entries.map((e) => e.name)).toEqual(["readme.txt", "cities5000.txt"])
    expect(entries[1].method).toBe(8)
  })

  it("finds the record behind an archive comment", () => {
    // The EOCD is searched for backwards precisely because a comment can push it
    // up to 64KB from the end. A reader that only checks the last 22 bytes finds
    // nothing and reports "not a zip" for a perfectly good archive.
    const zip = buildZip([{ name: "a.txt", content: text("x") }], { comment: "y".repeat(3000) })
    expect(parseCentralDirectory(zip).map((e) => e.name)).toEqual(["a.txt"])
  })

  it("refuses anything that is not a zip, rather than guessing", () => {
    expect(() => parseCentralDirectory(text("not a zip at all"))).toThrow(/no end-of-central-directory/)
  })

  it("says when the supplied bytes start after the directory", () => {
    // This is the signal `entriesFromUrl` uses to widen its ranged read. If it
    // stopped being an error the reader would silently parse from the wrong
    // offset, which is worse than a second request.
    const zip = buildZip([{ name: "a.txt", content: text("x") }])
    expect(() => parseCentralDirectory(zip.subarray(zip.length - 30), 1_000_000)).toThrow(/starts before/)
  })
})

describe("where an entry's bytes begin", () => {
  it("accounts for extra fields the central directory does not mention", async () => {
    /**
     * The hazard this whole file is organised around.
     *
     * The central directory records where the local header is, not where the
     * data is. The local header carries its own name and extra lengths, and real
     * archives put alignment and timestamp fields there that the central
     * directory does not repeat. Trusting one length for both reads from the
     * wrong offset — and the result inflates to garbage rather than throwing.
     */
    const zip = buildZip([{ name: "big.txt", content: text("payload") }], { extraInLocalHeader: 16 })
    const [entry] = parseCentralDirectory(zip)
    const header = zip.subarray(entry.headerOffset, entry.headerOffset + 30)
    const start = dataOffset(header, entry.headerOffset)
    // 30 fixed + 7 for "big.txt" + 16 of extra.
    expect(start).toBe(entry.headerOffset + 30 + 7 + 16)
    // And the bytes at that offset actually inflate to the payload. Asserting the
    // arithmetic alone would pass for an offset that happens to be 16 bytes wrong
    // in a way that still parses.
    const body = zip.subarray(start, start + entry.compressedSize)
    expect(await drain(inflate(streamOf(body), entry.method))).toBe("payload")
  })

  it("reads garbage, not an error, from the wrong offset", async () => {
    // Why the assertion above has to check the content: using the central
    // directory's extra length (zero) instead of the local header's produces a
    // stream that fails or yields nonsense — never a clear "wrong offset".
    const zip = buildZip([{ name: "big.txt", content: text("payload") }], { extraInLocalHeader: 16 })
    const [entry] = parseCentralDirectory(zip)
    const wrong = entry.headerOffset + 30 + 7 // the naive offset, missing the extra
    const body = zip.subarray(wrong, wrong + entry.compressedSize)
    const result = await drain(inflate(streamOf(body), entry.method)).catch(() => "<threw>")
    expect(result, "the naive offset must not silently produce the right answer").not.toBe("payload")
  })
})

describe("inflating", () => {
  const roundTrip = async (content: string, store: boolean) => {
    const zip = buildZip([{ name: "f.txt", content: text(content), store }])
    const [entry] = parseCentralDirectory(zip)
    const start = dataOffset(zip.subarray(entry.headerOffset, entry.headerOffset + 30), entry.headerOffset)
    return drain(inflate(streamOf(zip.subarray(start, start + entry.compressedSize)), entry.method))
  }

  it("reads a deflated entry", async () => {
    const body = "id\tname\tvalue\n".repeat(500)
    expect(await roundTrip(body, false)).toBe(body)
  })

  it("reads a stored entry unchanged", async () => {
    // Method 0. GeoNames uses it for tiny files and a reader that assumes
    // deflate throws on them.
    expect(await roundTrip("no compression here", true)).toBe("no compression here")
  })

  it("refuses a compression method it does not implement", () => {
    expect(() => inflate(streamOf(new Uint8Array()), 12)).toThrow(/unsupported zip compression method 12/)
  })

  it("cancels mid-stream without throwing", async () => {
    /**
     * The workerd bug this module was rewritten for.
     *
     * The first version bridged through `Readable.fromWeb(...).pipe(inflateRaw)`
     * and `Readable.toWeb(...)`. Cancelling that mid-flight throws inside
     * workerd's node shim:
     *
     *   TypeError: Cannot read properties of undefined (reading '_readableState')
     *
     * It passed the first live test only because the archive was small enough to
     * run to completion, so the cancel landed on a finished stream. Stopping
     * early is not an edge case — it is how a Workflow step takes a slice of a
     * 710MB entry and leaves the rest for the next one.
     */
    const body = "line\n".repeat(200_000)
    const zip = buildZip([{ name: "f.txt", content: text(body) }])
    const [entry] = parseCentralDirectory(zip)
    const start = dataOffset(zip.subarray(entry.headerOffset, entry.headerOffset + 30), entry.headerOffset)
    const stream = inflate(streamOf(zip.subarray(start, start + entry.compressedSize)), entry.method)
    const reader = stream.getReader()
    await reader.read()
    await expect(reader.cancel()).resolves.toBeUndefined()
  })
})

describe("what it deliberately refuses", () => {
  it("will not guess at a zip64 archive", () => {
    const zip = buildZip([{ name: "a.txt", content: text("x") }])
    const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    // Find the EOCD and mark it zip64 by setting the sentinel offset.
    let eocd = zip.length - 22
    while (dv.getUint32(eocd, true) !== 0x06054b50) eocd--
    dv.setUint32(eocd + 16, 0xffffffff, true)
    // Silent misreading would point at plausible garbage; refusing is the only
    // safe answer until the day GeoNames ships one.
    expect(() => parseCentralDirectory(zip)).toThrow(/zip64/)
  })

  it("is not confused by a gzip file", () => {
    expect(() => parseCentralDirectory(new Uint8Array(gzipSync(Buffer.from("hello"))))).toThrow(/not a zip/)
  })
})
