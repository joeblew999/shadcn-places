/**
 * The writer and the reader must slice the same way.
 *
 * `StageSources` writes names into partitions and `BuildDatabase` reads one
 * partition per step. If those two ever disagree the build does not fail — it
 * produces a database missing most of its names, successfully, which is the worst
 * available outcome.
 *
 * The first version had them disagree in a subtler way: the writer did not
 * partition at all, so every reader read everything and discarded nine tenths.
 * 322MB of JSON parsed to do 32MB of work. It survived the first run because the
 * stage had been limited to ~3MB of names, and hit the 30-second CPU wall the
 * moment it met the real 26.2MB — surfacing as "2 requests killed at 30 seconds
 * of CPU" in the dashboard rather than as a failing test.
 */

import { describe, it, expect } from "vitest"
import { PARTITIONS, partitionOf, namesKey, namesPrefix } from "../../src/etl/partition.ts"

describe("partitioning", () => {
  it("puts every place in exactly one partition, in range", () => {
    for (const id of ["city:1609350", "city:3040051", "city:1", "city:99999999"]) {
      const p = partitionOf(id)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThan(PARTITIONS)
    }
  })

  it("is stable, because a resumed Workflow must not redo work", () => {
    // Steps are named after their partition. If the mapping moved between runs, a
    // resume would compute a different slice under the same step name.
    expect(partitionOf("city:1609350")).toBe(partitionOf("city:1609350"))
  })

  it("spreads GeoNames ids evenly", () => {
    /**
     * `id % n` was the obvious choice and is the wrong one.
     *
     * GeoNames allocates ids in regional blocks, so the low digits clump — a
     * modulo split puts Thailand's cities in a handful of partitions and leaves
     * others near-empty. One oversized slice is the whole memory problem back
     * again, in one step instead of all of them.
     */
    const counts = new Array(PARTITIONS).fill(0)
    // A realistic spread: GeoNames ids run from six to eight digits, in blocks.
    for (let base of [1600000, 3040000, 5100000, 12040000]) {
      for (let i = 0; i < 2500; i++) counts[partitionOf(`city:${base + i * 7}`)]++
    }
    const total = counts.reduce((a, b) => a + b, 0)
    const expected = total / PARTITIONS
    for (const [i, n] of counts.entries()) {
      const drift = Math.abs(n - expected) / expected
      expect(drift, `partition ${i} holds ${n} of ${total}, ${(drift * 100).toFixed(0)}% off even`).toBeLessThan(0.15)
    }
  })

  it("keys a partition's files under a prefix the reader can list", () => {
    // The build lists `namesPrefix(part)` and reads whatever is there, so every
    // key the writer produces has to fall under it. A mismatch reads nothing and
    // reports success.
    for (let p = 0; p < PARTITIONS; p++) {
      for (const seq of [0, 4, 127]) {
        expect(namesKey(p, seq).startsWith(namesPrefix(p)), `${namesKey(p, seq)} is not under ${namesPrefix(p)}`).toBe(true)
      }
    }
  })

  it("does not let one partition's prefix match another's keys", () => {
    // `stage/names/p1/` must not also match `stage/names/p11/`. It does not,
    // because the trailing slash is part of the prefix — asserted because the
    // failure would be silent duplication rather than an error.
    for (let a = 0; a < PARTITIONS; a++) {
      for (let b = 0; b < PARTITIONS; b++) {
        if (a === b) continue
        expect(namesKey(b, 0).startsWith(namesPrefix(a)), `p${b} keys match p${a}'s prefix`).toBe(false)
      }
    }
  })
})
