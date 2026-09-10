/**
 * The zip reader against GeoNames' real servers.
 *
 * `tests/repo/zip.test.ts` builds archives in memory and covers the container
 * format. This covers the two things only the network can answer:
 *
 *   does GeoNames honour HTTP range requests at all — the whole design depends
 *   on reading a 64KB index out of a 193MB archive rather than downloading it
 *
 *   does a real archive's local header carry extra fields the central directory
 *   does not mention, which is the offset hazard the unit tests simulate
 *
 * Opt-in, because it downloads from somebody else's server: PLACES_LIVE_TEST=1.
 */

import { describe, it, expect } from "vitest"
import { entriesFromUrl, openEntry } from "../../src/etl/zip.ts"

const enabled = process.env.PLACES_LIVE_TEST === "1"
const CITIES = "https://download.geonames.org/export/dump/cities5000.zip"
const ALTERNATES = "https://download.geonames.org/export/dump/alternateNames.zip"

describe.skipIf(!enabled)("reading GeoNames archives over the network", () => {
  it(
    "reads the index of a 193MB archive without downloading it",
    async () => {
      let transferred = 0
      const counting: typeof fetch = async (u, init) => {
        const res = await fetch(u as string, init as RequestInit)
        // Body bytes, not the content-length a HEAD advertises. Counting the
        // header made the first measurement of this report 197MB for a 64KB read.
        if ((init as RequestInit | undefined)?.method !== "HEAD") {
          transferred += (await res.clone().arrayBuffer()).byteLength
        }
        return res
      }
      const { entries, size } = await entriesFromUrl(ALTERNATES, counting)
      expect(size).toBeGreaterThan(150 * 1024 * 1024)
      expect(entries.map((e) => e.name)).toContain("alternateNames.txt")
      expect(
        transferred,
        "reading the index downloaded more than 1MB — ranged requests are not working, " +
          "and this design assumes they do",
      ).toBeLessThan(1024 * 1024)
    },
    120_000,
  )

  it(
    "streams an entry and stops early without throwing",
    async () => {
      /**
       * The workerd failure this module was rewritten for, exercised end to end.
       *
       * Stopping early is not an edge case: it is how a Workflow step takes a
       * slice of a 710MB entry and leaves the rest for the next one. The Node
       * stream bridge threw `Cannot read properties of undefined (reading
       * '_readableState')` here, and passed an earlier version of this test only
       * because that archive ran to completion first.
       */
      const { entries } = await entriesFromUrl(ALTERNATES)
      const target = entries.find((e) => e.name === "alternateNames.txt")!
      expect(target.uncompressedSize).toBeGreaterThan(500 * 1024 * 1024)

      const reader = (await openEntry(ALTERNATES, target)).getReader()
      let bytes = 0
      for (let i = 0; i < 20; i++) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.length
      }
      expect(bytes).toBeGreaterThan(0)
      await expect(reader.cancel()).resolves.toBeUndefined()
    },
    180_000,
  )

  it(
    "inflates a whole entry to the line count the pipeline expects",
    async () => {
      // cities5000 is small enough to read fully and is the file the city
      // inventory comes from, so the count is a real invariant rather than a
      // smoke test: if it collapses, the archive changed shape.
      const { entries } = await entriesFromUrl(CITIES)
      const target = entries.find((e) => e.name === "cities5000.txt")!
      const reader = (await openEntry(CITIES, target)).getReader()
      const decoder = new TextDecoder()
      let lines = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        for (let i = 0; i < chunk.length; i++) if (chunk[i] === "\n") lines++
      }
      expect(lines).toBeGreaterThan(60_000)
    },
    180_000,
  )
})

describe.skipIf(enabled)("live zip test", () => {
  it("is skipped unless asked for", () => {
    // Stated rather than silent, so a green suite is not read as proof that
    // ranged reads against GeoNames still work.
    expect(enabled).toBe(false)
  })
})
