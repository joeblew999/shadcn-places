/**
 * The registry points at files that exist, and declares what it needs.
 *
 * A registry item is the one artefact here that is never compiled in this
 * repository — it is copied into somebody else's project and built against their
 * shadcn components. So the failure mode is not a type error, it is a stranger
 * running `shadcn add` and getting a 404 or a component that imports a `Popover`
 * they were never told to install. Neither shows up in any build of ours.
 *
 * These are the two things that can be checked from here, and they are exactly
 * the two that break.
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, it, expect } from "vitest"

const ROOT = resolve(import.meta.dirname, "../..")
const json = (f: string) => JSON.parse(readFileSync(resolve(ROOT, f), "utf8"))

interface Item {
  name: string
  files?: { path: string; target?: string }[]
  registryDependencies?: string[]
  dependencies?: string[]
}

describe("registry", () => {
  const registry = json("registry.json") as { items: Item[] }

  it("has at least one item", () => {
    expect(registry.items.length).toBeGreaterThan(0)
  })

  for (const item of registry.items) {
    describe(item.name, () => {
      it("points at files that exist", () => {
        for (const file of item.files ?? []) {
          expect(existsSync(resolve(ROOT, file.path)), `${item.name} → ${file.path} does not exist`).toBe(true)
        }
      })

      it("declares every shadcn component its source imports", () => {
        // Parsed from the source rather than trusted, because the import is added
        // during development and the manifest is remembered afterwards, if at all.
        const source = (item.files ?? []).map((f) => readFileSync(resolve(ROOT, f.path), "utf8")).join("\n")
        const used = new Set(
          [...source.matchAll(/from\s+["']@\/components\/ui\/([a-z-]+)["']/g)].map((m) => m[1]),
        )
        const declared = new Set(item.registryDependencies ?? [])
        for (const component of used) {
          expect(declared.has(component), `${item.name} imports ${component} but does not list it in registryDependencies`).toBe(true)
        }
      })

      it("declares its npm dependencies", () => {
        const source = (item.files ?? []).map((f) => readFileSync(resolve(ROOT, f.path), "utf8")).join("\n")
        const declared = new Set(item.dependencies ?? [])
        if (/from\s+["']lucide-react["']/.test(source)) {
          expect(declared.has("lucide-react"), `${item.name} imports lucide-react but does not declare it`).toBe(true)
        }
      })

      it("has a standalone item file, which is what `shadcn add <url>` fetches", () => {
        const path = `registry/${item.name}.json`
        expect(existsSync(resolve(ROOT, path)), `${path} is missing — the URL form of the install would 404`).toBe(true)
        const standalone = json(path) as Item
        expect(standalone.name).toBe(item.name)
        // Two copies of the same manifest is how they drift. Checked rather than
        // deduplicated, because the two files have genuinely different schemas.
        expect(new Set(standalone.registryDependencies ?? [])).toEqual(new Set(item.registryDependencies ?? []))
      })
    })
  }
})
