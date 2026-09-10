/**
 * The package compiles in somebody else's tsconfig, not just in ours.
 *
 * `shadcn-places/client` was in the README from the first day. It was then
 * missing entirely for a day. It was then present, exercised over RPC by the
 * service tests, and **still uncompilable by anyone who installed it** — because
 * it imported `./api/contract.ts` with the extension, and a `.ts` import
 * extension requires `allowImportingTsExtensions`, which this repository sets and
 * a consumer does not:
 *
 *   error TS5097: An import path can only end with a '.ts' extension when
 *   'allowImportingTsExtensions' is enabled
 *
 * Every test passed. The service tests imported it through *our* tsconfig, so
 * they proved it worked here and said nothing about there. It was found the day
 * `example/` first imported the typed client instead of hand-rolling one.
 *
 * That is now the fourth artefact this project published, documented, and never
 * once executed the way a stranger would — after the registry item, the client's
 * own existence, and the OpenAPI document. The pattern is specific enough to
 * check mechanically, so this does.
 *
 * `example/` remains the real proof, because only a consumer's compiler can be
 * sure. This is the cheap version that runs in two milliseconds on every commit.
 */

import { readFileSync, existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { describe, it, expect } from "vitest"

const ROOT = resolve(import.meta.dirname, "../..")
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
  exports?: Record<string, string>
  files?: string[]
  peerDependencies?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/**
 * Source with comments removed.
 *
 * The first version of this scanned raw text and reported `src/client.ts imports
 * "shadcn-places"` — from a doc comment quoting the import a *consumer* writes.
 * A checker that reads prose as code produces findings nobody can act on, which
 * is how checks get switched off.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
}

/** Every entry point in the export map, as a repo-relative path. */
const entries = Object.values(pkg.exports ?? {})

/**
 * Follow relative imports from an entry point, breadth-first.
 *
 * Only relative ones: a bare specifier is a dependency's problem and is covered
 * by the peer-dependency check below.
 */
function reachable(from: string): string[] {
  const seen = new Set<string>()
  const queue = [resolve(ROOT, from)]
  while (queue.length) {
    const file = queue.shift()!
    if (seen.has(file) || !existsSync(file)) continue
    seen.add(file)
    const source = code(readFileSync(file, "utf8"))
    for (const m of source.matchAll(/(?:from|import)\s*["'](\.[^"']+)["']/g)) {
      const spec = m[1]
      const base = resolve(dirname(file), spec)
      for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
        if (existsSync(candidate) && candidate.endsWith(".ts")) { queue.push(candidate); break }
      }
    }
  }
  return [...seen]
}

describe("the published package", () => {
  it("declares an export map", () => {
    expect(entries.length, "no exports — `import from \"shadcn-places/client\"` resolves to nothing").toBeGreaterThan(0)
  })

  for (const entry of entries) {
    describe(entry, () => {
      it("exists", () => {
        expect(existsSync(resolve(ROOT, entry)), `${entry} is in exports and not on disk`).toBe(true)
      })

      it("uses no .ts import extension anywhere it can reach", () => {
        /**
         * The actual bug, stated as a rule.
         *
         * This repository imports with `.ts` everywhere on purpose and that is
         * fine — for files nobody else compiles. A published entry point and
         * everything it pulls in is compiled by the consumer, under the
         * consumer's flags, and `allowImportingTsExtensions` is not one a
         * consumer has any reason to set.
         */
        const offenders: string[] = []
        for (const file of reachable(entry)) {
          const source = code(readFileSync(file, "utf8"))
          for (const m of source.matchAll(/(?:from|import)\s*["'](\.[^"']*\.ts)["']/g)) {
            offenders.push(`${file.slice(ROOT.length + 1)} imports "${m[1]}"`)
          }
        }
        expect(
          offenders,
          "a published entry point imports with a .ts extension. It compiles here because " +
            "tsconfig sets allowImportingTsExtensions, and fails with TS5097 in every project " +
            "that installs this package. Drop the extension",
        ).toEqual([])
      })

      it("is inside the published files", () => {
        // `files` decides what npm actually ships. An export map pointing at a
        // path that is not packed is a 404 on install rather than at compile.
        const top = entry.replace(/^\.\//, "").split("/")[0]
        expect(
          (pkg.files ?? []).includes(top),
          `${entry} is exported but "${top}" is not in package.json "files" — it would not ship`,
        ).toBe(true)
      })
    })
  }

  it("declares every bare import its entry points make", () => {
    /**
     * `@orpc/openapi` was missing.
     *
     * src/api/contract.ts imports `openapi` from it, contract.ts is a published
     * entry point, and nothing declared the dependency — so a consumer installing
     * this package got a module-not-found from inside our own code.
     *
     * Checked against peers *and* dependencies: which of the two is right is a
     * judgement about version coupling; being in neither is never right.
     */
    const declared = new Set([
      ...Object.keys(pkg.peerDependencies ?? {}),
      ...Object.keys(pkg.dependencies ?? {}),
    ])
    const missing = new Set<string>()
    for (const entry of entries) {
      for (const file of reachable(entry)) {
        const source = code(readFileSync(file, "utf8"))
        for (const m of source.matchAll(/(?:from|import)\s*["']([^."'][^"']*)["']/g)) {
          const spec = m[1]
          if (spec.startsWith("node:") || spec.startsWith("cloudflare:")) continue
          // "@scope/name/sub" and "name/sub" both declare as their package root.
          const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]
          if (!declared.has(name)) missing.add(`${file.slice(ROOT.length + 1)} imports "${name}"`)
        }
      }
    }
    expect(
      [...missing],
      "a published entry point imports a package that is in neither peerDependencies nor " +
        "dependencies. Installing this package would resolve it only by luck of hoisting",
    ).toEqual([])
  })
})
