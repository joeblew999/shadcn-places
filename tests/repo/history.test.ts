/**
 * The record survives a round trip, and says so when it does not.
 *
 * `places history` exists because `places diff` computed a full comparison on
 * every run — every edit, every demotion — printed six lines of it and threw the
 * rest away. So "when did this name change?" had no answer short of checking out
 * old commits and rebuilding, which nobody was ever going to do.
 *
 * A record nobody can query is the same as no record, so these run the actual CLI
 * against a temporary `PLACES_DATA` and read the answers back. Pointed at a temp
 * directory rather than `data/`, because a test that writes to the published
 * artefacts is a test that dirties the repository every time it passes.
 */

import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, it, expect, beforeAll, afterAll } from "vitest"

const ROOT = resolve(import.meta.dirname, "../..")

let DATA: string
let OUT: string

const places = (...args: string[]) =>
  spawnSync("bun", ["scripts/places.ts", "history", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, PLACES_DATA: DATA, PLACES_OUT: OUT },
  })

/** A change of the shape `places diff` writes, small enough to assert on exactly. */
const change = (at: string, edits: string[], demoted: string[], byLocale: Record<string, number>) => ({
  at,
  tiers: [
    {
      tier: "cities",
      places: { before: 10, after: 10, added: 0, removed: [] as string[] },
      names: { after: 100, added: Object.values(byLocale).reduce((a, b) => a + b, 0), removed: 0, changed: edits.length },
      byLocale,
      demoted,
      edits,
      truncated: 0,
    },
  ],
})

beforeAll(() => {
  DATA = mkdtempSync(join(tmpdir(), "places-history-data-"))
  OUT = mkdtempSync(join(tmpdir(), "places-history-out-"))
  mkdirSync(OUT, { recursive: true })
})

afterAll(() => {
  rmSync(DATA, { recursive: true, force: true })
  rmSync(OUT, { recursive: true, force: true })
})

const record = (c: ReturnType<typeof change>, ...args: string[]) => {
  writeFileSync(join(OUT, "change.json"), JSON.stringify(c))
  return places("--append", ...args)
}

describe("places history", () => {
  it("says so rather than failing when there is nothing yet", () => {
    const res = places()
    expect(res.status).toBe(0)
    expect(res.stdout).toMatch(/no history yet/)
  })

  it("refuses to append without a comparison to append", () => {
    // The failure mode this replaces is a silent no-op leaving a gap in the
    // record that looks identical to a week when nothing changed.
    const res = places("--append")
    expect(res.status).not.toBe(0)
    expect(res.stderr).toMatch(/change\.json/)
  })

  it("records a publish and reads it back", () => {
    const res = record(
      change(
        "2026-03-01T00:00:00.000Z",
        ["city:1 th: กรุงเทพ → กรุงเทพมหานคร"],
        [],
        { th: 40, ja: 10 },
      ),
    )
    expect(res.status, res.stderr).toBe(0)
    expect(existsSync(join(DATA, "history.ndjson.gz")), "nothing was written").toBe(true)

    const listed = places()
    expect(listed.stdout).toMatch(/1 publish/)
    expect(listed.stdout).toMatch(/2026-03-01/)
  })

  it("does not record the same comparison twice", () => {
    // `sync` diffs for the gate and appends after publishing; re-running a failed
    // sync would otherwise write the identical comparison again and double every
    // count derived from it.
    const res = record(change("2026-03-01T00:00:00.000Z", [], [], { th: 40 }))
    expect(res.stdout).toMatch(/already recorded/)
    expect(places().stdout).toMatch(/1 publish/)
  })

  it("does not record a publish that changed nothing", () => {
    const res = record(change("2026-03-02T00:00:00.000Z", [], [], {}))
    expect(res.stdout).toMatch(/nothing changed/)
    expect(places().stdout).toMatch(/1 publish/)
  })

  it("answers when a language gained or lost, with a running total", () => {
    record(change("2026-04-01T00:00:00.000Z", [], [], { th: 60 }))
    const res = places("th")
    expect(res.stdout).toMatch(/2026-03-01/)
    expect(res.stdout).toMatch(/2026-04-01/)
    // 40 then 60. The running total is the point: the per-publish delta alone
    // cannot answer "how much Thai do we have now".
    expect(res.stdout).toMatch(/running 100/)
  })

  it("answers when one place's name changed, and to what", () => {
    const res = places("city:1")
    expect(res.status).toBe(0)
    expect(res.stdout, "the before and after are the whole answer").toMatch(/กรุงเทพ → กรุงเทพมหานคร/)
  })

  it("finds a name by text as well as by id", () => {
    // Nobody chasing a bad translation knows the GeoNames id. They know the word.
    expect(places("กรุงเทพมหานคร").stdout).toMatch(/city:1/)
  })

  it("says when absence is not proof, because the record was capped", () => {
    const capped = change("2026-05-01T00:00:00.000Z", [], [], { th: 1 })
    capped.tiers[0].truncated = 900
    record(capped)
    const res = places("nothing-like-this-was-ever-recorded")
    expect(res.stdout).toMatch(/nothing recorded/)
    expect(
      res.stdout,
      "a capped record that reports absence as certainty is worse than no record",
    ).toMatch(/absence here is not proof/)
  })

  it("marks a reconstructed entry rather than passing it off as contemporary", () => {
    record(change("2026-02-01T00:00:00.000Z", [], [], { ja: 5 }), "--sha=deadbee", "--reconstructed")
    const res = places()
    expect(res.stdout).toMatch(/reconstructed after the fact/)
    // Backfilled into date order, not appended — a running total that climbs and
    // falls because an old entry landed last is a graph nobody can read.
    const lines = res.stdout.split("\n").filter((l) => /^\s+2026-/.test(l))
    const dates = lines.map((l) => l.trim().slice(0, 10))
    expect(dates).toEqual([...dates].sort())
  })
})
