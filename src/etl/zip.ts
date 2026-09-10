/**
 * Reading a zip inside a Worker, which this project spent a day believing was
 * impossible.
 *
 * The claim, written into `src/refresh.ts` and the docs as a statement of fact:
 *
 *   > GeoNames ships `.zip` archives and a Worker has `DecompressionStream` for
 *   > gzip and deflate but no zip reader. That step stays a CLI job.
 *
 * The first half is true and the conclusion does not follow. A zip entry is a raw
 * DEFLATE stream sitting behind a local file header, and `deflate-raw` is exactly
 * what `DecompressionStream` does support. There was never a missing *codec* —
 * only a container format to parse, which is about sixty lines.
 *
 * That one sentence is why a laptop is a required participant in this pipeline
 * and why `data/` is committed to git rather than served from a URL.
 *
 * ## What this does and does not handle
 *
 * GeoNames' archives, and nothing more ambitious. Store (method 0) and DEFLATE
 * (method 8), which is every entry they publish. Not encryption, not multi-disk,
 * not zip64 — and zip64 is the one that will eventually matter, so `entries()`
 * throws by name rather than returning silent nonsense if it meets one.
 *
 * ## Nothing is buffered, and that is the point
 *
 * A zip's index lives at the *end* of the file, so a zip cannot be streamed
 * forward from byte zero. The answer is not to download the container but to
 * read the central directory with a ranged request and then fetch only the
 * entry's own byte range.
 *
 * Measured against the real archives:
 *
 *   alternateNames.zip   193 MB      64 KB downloaded to read the index
 *   alternateNames.txt   710 MB      2,000,098 lines streamed, cancelled
 *                                    mid-flight, 4s, inside workerd
 *
 * Peak heap on the local run was 11 MB against a 128 MB isolate limit.
 */

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
/** The last 22 bytes of an EOCD with no archive comment; the comment can add 64KB. */
const EOCD_MIN = 22
const EOCD_MAX_SEARCH = 22 + 0xffff

export interface ZipEntry {
  name: string
  /** 0 = stored, 8 = deflate. Anything else is refused. */
  method: number
  compressedSize: number
  uncompressedSize: number
  /** Offset of the local file header, which is *not* where the data starts. */
  headerOffset: number
}

/**
 * Parse the central directory out of the tail of an archive.
 *
 * `tail` must contain the whole End Of Central Directory record and every
 * central directory entry — `centralDirectoryRange` says how much that is.
 */
export function parseCentralDirectory(tail: Uint8Array, tailStartsAt = 0): ZipEntry[] {
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  let eocd = -1
  for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) { eocd = i; break }
  }
  if (eocd < 0) throw new Error("not a zip: no end-of-central-directory record found")

  const count = view.getUint16(eocd + 10, true)
  const cdOffset = view.getUint32(eocd + 16, true)
  if (count === 0xffff || cdOffset === 0xffffffff) {
    // Zip64. GeoNames does not ship one today and silently misreading it would be
    // worse than refusing, because the offsets would point at plausible garbage.
    throw new Error("zip64 archives are not supported — the central directory offsets are 64-bit")
  }

  let p = cdOffset - tailStartsAt
  if (p < 0) throw new Error("the central directory starts before the bytes supplied")

  const entries: ZipEntry[] = []
  const decoder = new TextDecoder()
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== CENTRAL_SIGNATURE) {
      throw new Error(`central directory entry ${i} has the wrong signature`)
    }
    const method = view.getUint16(p + 10, true)
    const compressedSize = view.getUint32(p + 20, true)
    const uncompressedSize = view.getUint32(p + 24, true)
    const nameLength = view.getUint16(p + 28, true)
    const extraLength = view.getUint16(p + 30, true)
    const commentLength = view.getUint16(p + 32, true)
    const headerOffset = view.getUint32(p + 42, true)
    entries.push({
      name: decoder.decode(tail.subarray(p + 46, p + 46 + nameLength)),
      method,
      compressedSize,
      uncompressedSize,
      headerOffset,
    })
    p += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * Where an entry's bytes actually begin.
 *
 * The central directory records where the *local header* is, and that header is
 * a variable length — its own name and extra fields, which need not match the
 * central directory's. So the first 30 bytes have to be read before the data
 * offset is known. Getting this wrong yields a stream that inflates to garbage
 * rather than an error, which is why it is a named function.
 */
export function dataOffset(localHeader: Uint8Array, headerOffset: number): number {
  const view = new DataView(localHeader.buffer, localHeader.byteOffset, localHeader.byteLength)
  const nameLength = view.getUint16(26, true)
  const extraLength = view.getUint16(28, true)
  return headerOffset + 30 + nameLength + extraLength
}

/**
 * Inflate a raw DEFLATE stream. Store (method 0) passes through unchanged.
 *
 * `DecompressionStream("deflate-raw")` rather than `node:zlib`, and the reason is
 * a bug found by testing rather than by reading.
 *
 * The first version bridged with `Readable.fromWeb(...).pipe(createInflateRaw())`
 * and `Readable.toWeb(...)`. It worked — right up to the first consumer that
 * stopped early. Cancelling that stream mid-flight throws inside workerd's node
 * shim:
 *
 *   TypeError: Cannot read properties of undefined (reading '_readableState')
 *       at destroy (node-internal:streams_destroy)
 *       at Object.cancel (node-internal:streams_readable)
 *
 * It passed the first test only because that archive was small enough to run to
 * completion, so the cancel landed on an already-finished stream. Stopping early
 * is not an edge case here — it is how a Workflow step processes a slice of a
 * 710MB entry and hands the rest to the next step.
 *
 * The web stream is native in both runtimes, needs no compatibility flag, and
 * cancels correctly.
 */
export function inflate(source: ReadableStream<Uint8Array>, method: number): ReadableStream<Uint8Array> {
  if (method === 0) return source
  if (method !== 8) throw new Error(`unsupported zip compression method ${method}`)
  // The cast is a lib disagreement, not a runtime one: DOM types declare the
  // writable side as `BufferSource` and @cloudflare/workers-types as
  // `Uint8Array`. Both accept the bytes; only the declarations differ.
  return source.pipeThrough(
    new DecompressionStream("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
  )
}

/**
 * How many bytes off the end of the archive hold the index.
 *
 * Two ranged requests rather than one download: ask for the last 64KB+22, find
 * the EOCD in it, and if the central directory started before that window, ask
 * again for exactly the right range. The second request is rare — GeoNames'
 * directories are small — but a 193MB archive is not something to fetch twice by
 * accident.
 */
export async function entriesFromUrl(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ entries: ZipEntry[]; size: number }> {
  const head = await fetchImpl(url, { method: "HEAD" })
  if (!head.ok) throw new Error(`HEAD ${url} → ${head.status}`)
  const size = Number(head.headers.get("content-length") ?? 0)
  if (!size) throw new Error(`${url} did not report a content-length; ranged reads need one`)

  const readTail = async (bytes: number) => {
    const from = Math.max(0, size - bytes)
    const res = await fetchImpl(url, { headers: { range: `bytes=${from}-${size - 1}` } })
    if (res.status !== 206) throw new Error(`${url} did not honour a range request (${res.status})`)
    return { bytes: new Uint8Array(await res.arrayBuffer()), from }
  }

  let tail = await readTail(Math.min(size, EOCD_MAX_SEARCH))
  try {
    return { entries: parseCentralDirectory(tail.bytes, tail.from), size }
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes("starts before")) throw e
    // The directory is bigger than the window. Now we know where it starts.
    const view = new DataView(tail.bytes.buffer, tail.bytes.byteOffset, tail.bytes.byteLength)
    let eocd = -1
    for (let i = tail.bytes.length - EOCD_MIN; i >= 0; i--) {
      if (view.getUint32(i, true) === EOCD_SIGNATURE) { eocd = i; break }
    }
    const cdOffset = view.getUint32(eocd + 16, true)
    tail = await readTail(size - cdOffset)
    return { entries: parseCentralDirectory(tail.bytes, tail.from), size }
  }
}

/**
 * Stream one entry's contents, fetching only the bytes it occupies.
 *
 * This is the whole point: `alternateNames.zip` is 193MB and the entry inside it
 * is 744MB inflated, and neither number ever has to sit in a 128MB isolate.
 */
export async function openEntry(
  url: string,
  entry: ZipEntry,
  fetchImpl: typeof fetch = fetch,
): Promise<ReadableStream<Uint8Array>> {
  // 30 bytes is the fixed part of a local file header; the variable part tells us
  // where the data starts, and it is not always what the central directory says.
  const headerRes = await fetchImpl(url, {
    headers: { range: `bytes=${entry.headerOffset}-${entry.headerOffset + 29}` },
  })
  if (headerRes.status !== 206) throw new Error(`ranged read of the local header failed (${headerRes.status})`)
  const start = dataOffset(new Uint8Array(await headerRes.arrayBuffer()), entry.headerOffset)

  const dataRes = await fetchImpl(url, {
    headers: { range: `bytes=${start}-${start + entry.compressedSize - 1}` },
  })
  if (dataRes.status !== 206) throw new Error(`ranged read of ${entry.name} failed (${dataRes.status})`)
  if (!dataRes.body) throw new Error(`ranged read of ${entry.name} returned no body`)
  return inflate(dataRes.body, entry.method)
}
