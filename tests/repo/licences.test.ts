/**
 * The licence promises this repository makes, held by a test.
 *
 * Not ceremony. This project takes data from a share-alike source, so publishing
 * the ETL while keeping the derived rows private would look like compliance from
 * outside and not be it. And the name — `shadcn-places` — sets an expectation of
 * MIT throughout that the data licence breaks, so the README has to answer the
 * API-versus-database question where a reader will actually see it.
 *
 * Both of those are the kind of thing that is true on the day it is written and
 * quietly stops being true six months later. That is what a check is for.
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { it, expect, describe } from "vitest"
import { SOURCES } from "../../scripts/lib/sources.ts"

const ROOT = resolve(import.meta.dirname, "../..")
const read = (f: string) => (existsSync(resolve(ROOT, f)) ? readFileSync(resolve(ROOT, f), "utf8") : "")

describe("licences", () => {
  it("states the code licence and the data licence separately", () => {
    // One LICENSE file covering both would have to be ODbL, which would make the
    // React component share-alike and stop anyone adopting it.
    expect(read("LICENSE"), "LICENSE (code) is missing").toContain("MIT")
    expect(read("LICENSE-DATA"), "LICENSE-DATA is missing").toContain("Open Database License")
  })

  it("says the code licence does not cover the data, and vice versa", () => {
    // A reader who finds only one of the two files must still learn there is
    // another. Cross-referencing is what makes them a pair rather than a
    // contradiction.
    expect(read("LICENSE")).toContain("LICENSE-DATA")
    expect(read("LICENSE-DATA")).toContain("LICENSE")
  })

  it("answers API-versus-database in the README, above the fold", () => {
    const readme = read("README.md")
    const head = readme.slice(0, 2200)
    expect(head, "the licence answer is not in the first screen").toMatch(/hosted API/i)
    expect(head).toMatch(/Redistribut/i)
    // The specific claim that makes adoption possible: calling the API is not
    // creating a derivative database. Without it a reader assumes the worst.
    expect(head).toMatch(/Produced Work/i)
  })

  it("disclaims affiliation with shadcn/ui", () => {
    // Every popular shadcn-* project carries this line. Free insurance, and the
    // name was chosen for reach, which makes the disclaimer more necessary rather
    // than less.
    expect(read("README.md")).toMatch(/not affiliated/i)
  })

  it("credits every source that requires attribution", () => {
    const readme = read("README.md")
    const data = read("LICENSE-DATA")
    for (const s of SOURCES) {
      if (s.licence === "Unicode" || s.licence === "CC0") continue
      const named = readme.includes(s.id.split("-")[0]) || data.includes(s.id.split("-")[0])
      expect(named, `${s.id} is ${s.licence} and needs a visible credit`).toBe(true)
    }
  })

  it("names the share-alike source, so nobody has to rediscover which one it is", () => {
    const shareAlike = SOURCES.filter((s) => s.shareAlike)
    expect(shareAlike.length, "no share-alike source declared — has one been added without the flag?").toBeGreaterThan(0)
    for (const s of shareAlike) expect(read("LICENSE-DATA")).toContain(s.id.split("/")[0].split("-")[0])
  })
})
