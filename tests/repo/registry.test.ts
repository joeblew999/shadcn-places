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
import { execSync } from "node:child_process"
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

      it("SERVES the source, not just a path to it", () => {
        /**
         * The check that was missing, and the bug it would have caught.
         *
         * `registry.json` names files by path, which means something here and
         * nothing to somebody's `shadcn add`. The served item must carry the file
         * *content* — and mine did not, so installing fetched the item, wrote
         * button, command, dialog and popover, and silently skipped the component
         * itself. It exited zero and printed a success.
         *
         * The one thing this project asks people to install had never once
         * installed, and this file passed the whole time because it verified the
         * path existed *in this repository*.
         */
        const served = resolve(ROOT, "public", `${item.name}.json`)
        expect(existsSync(served), `public/${item.name}.json is missing — run: bun run places registry`).toBe(true)
        const built = json(`public/${item.name}.json`) as { files?: { content?: string; target?: string }[] }
        expect(built.files?.length, "the served item has no files").toBeGreaterThan(0)
        for (const f of built.files ?? []) {
          expect(f.content?.length, `a served file has no content — the installer has no way to write it`).toBeGreaterThan(100)
          expect(f.target, "a served file has no target — the installer will not know where to put it").toBeTruthy()
        }
      })

      it("serves the same source that is in the repository", () => {
        // Generated files drift. If these disagree, `places registry` has not been
        // re-run since the component changed and installers get the old one.
        const built = json(`public/${item.name}.json`) as { files?: { path: string; content: string }[] }
        for (const f of built.files ?? []) {
          expect(f.content, `public/${item.name}.json is stale — run: bun run places registry`).toBe(
            readFileSync(resolve(ROOT, f.path), "utf8"),
          )
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

describe("nothing hardcodes a list of languages", () => {
  /**
   * The mistake this project keeps making, in three different files.
   *
   * Once in the ETL, which had a locale list of its own. Once in the scorer, which
   * imported an application's `ALL_LOCALES` — reasonable in the repository it came
   * from and wrong in a service that holds every language. Once in the demo, which
   * offered twelve locales typed into HTML while the database held 664.
   *
   * Every instance was defensible when written and every one made the service
   * quietly narrower than it is. A locale list is a decision that belongs to a
   * caller, at request time, which is the one claim this whole project rests on.
   *
   * `CLDR_LOCALES` in the extractor is the deliberate exception, and it is about
   * what CLDR *has* rather than what anyone wants. It is named in the allowlist so
   * that adding a second exception is a conscious act.
   *
   * `NON_LATIN_SCRIPT` used to be on this list and has been deleted rather than
   * exempted. It was fifty language codes typed by hand and it was missing
   * thirty-nine — which is the failure this check exists to catch, sitting inside
   * the check's own allowlist. The classification is derived now: from the names
   * themselves where there are enough, and from CLDR below that. What remains is
   * `SCRIPT_OVERRIDES`, an object of eleven entries that each carry their reason,
   * and it does not match this pattern because it is not a list of languages —
   * it is a list of disagreements.
   */
  const ALLOWED = new Set(["CLDR_LOCALES", "DEFAULT_LOCALES", "NOT_LANGUAGES"])

  it("has no literal locale array outside the places that declare why", () => {
    const files = execSync("git ls-files 'src/**/*.ts' 'scripts/**/*.ts' 'public/*.html'", {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean)

    const offenders: string[] = []
    for (const file of files) {
      const text = readFileSync(resolve(ROOT, file), "utf8")
      // Four or more two-letter quoted strings in a row is a language list and
      // almost nothing else. Three would catch coordinate tuples and ISO pairs.
      const re = /(?:const|let|var)\s+(\w+)[^=]*=\s*\[\s*(?:"[a-z]{2,3}"|'[a-z]{2,3}')\s*,\s*(?:"[a-z]{2,3}"|'[a-z]{2,3}')\s*,\s*(?:"[a-z]{2,3}"|'[a-z]{2,3}')\s*,\s*(?:"[a-z]{2,3}"|'[a-z]{2,3}')/g
      for (const m of text.matchAll(re)) {
        if (!ALLOWED.has(m[1])) offenders.push(`${file}: ${m[1]}`)
      }
    }
    expect(
      offenders,
      "a hardcoded language list. The service holds every language; the caller narrows it",
    ).toEqual([])
  })
})
