/**
 * Install the registry item into a consumer project, and compile it.
 *
 * The one artefact this repository publishes and never compiles. `shadcn add`
 * silently wrote four dependencies and skipped the component itself for a day —
 * exit zero, "✔ Created 4 files" — while the demo worked, the API worked, and the
 * repo's own checks verified a file path that existed *here* rather than the item
 * served over the wire.
 *
 * So the only honest test is to install it somewhere else and see whether it
 * compiles. `example/` is that somewhere else: a consumer's tsconfig, a
 * consumer's `@/` alias, a consumer's own shadcn components.
 *
 * Slow and network-dependent, so it is opt-in: PLACES_INSTALL_TEST=1. The rest of
 * the suite stays fast and a fresh clone does not fail for having no network.
 */

import { describe, it, expect } from "vitest"
import { spawnSync } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { resolve } from "node:path"

const ROOT = resolve(import.meta.dirname, "../..")
const EXAMPLE = resolve(ROOT, "example")
const enabled = process.env.PLACES_INSTALL_TEST === "1"

const run = (cmd: string, args: string[]) =>
  spawnSync(cmd, args, { cwd: EXAMPLE, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })

describe.skipIf(!enabled)("the published component installs and compiles", () => {
  it(
    "installs from the served registry URL and typechecks",
    async () => {
      // Removed first: the test is whether the *installer* produces it, and a
      // leftover from a previous run would pass without installing anything.
      rmSync(resolve(EXAMPLE, "src/components"), { recursive: true, force: true })

      /**
       * The link to the parent package, which `Typed.tsx` imports.
       *
       * Deliberately not a bun workspace: hoisting would let this project resolve
       * packages from the parent's node_modules that a real consumer would not
       * have, and "the test passed for the wrong reason" is the failure this whole
       * directory exists to prevent. So the link is explicit and made here, where
       * a fresh clone gets it without anybody remembering.
       */
      const linked = run("bun", ["run", "setup"])
      expect(linked.status, `bun run setup failed:\n${linked.stderr}`).toBe(0)

      const installed = run("bun", ["run", "install-picker"])
      expect(installed.status, `shadcn add failed:\n${installed.stderr}`).toBe(0)

      /**
       * The components themselves, not just their dependencies.
       *
       * This is the assertion that was missing. `shadcn add` reports success for
       * having written the registryDependencies, so the exit code proves nothing
       * about the thing you asked for.
       *
       * Both items are checked because the failure is per item: `places-coverage`
       * installed cleanly on its own and silently did not when it was the second
       * URL in one `shadcn add` — the CLI reads the first argument as the registry
       * and every later one as a *name* inside it.
       */
      for (const item of ["places-picker", "places-coverage"]) {
        expect(
          existsSync(resolve(EXAMPLE, `src/components/${item}.tsx`)),
          `shadcn add reported success but wrote no ${item}.tsx — the served item is missing file content`,
        ).toBe(true)
      }

      /**
       * Compiles under a consumer's tsconfig, which is the only compiler that counts.
       *
       * `example/` now imports `shadcn-places/client` as well as the components,
       * and that is what caught TS5097: the published entry point imported
       * `./api/contract.ts` with the extension, which needs
       * `allowImportingTsExtensions` — a flag this repository sets and a consumer
       * has no reason to. Every one of our own tests passed, because they compiled
       * it through our tsconfig.
       */
      const checked = run("bun", ["run", "check"])
      expect(checked.status, `the installed component does not compile:\n${checked.stdout}`).toBe(0)
    },
    180_000,
  )
})

describe.skipIf(enabled)("install test", () => {
  it("is skipped unless asked for", () => {
    // Stated rather than silent, so nobody reads a green suite as proof the
    // component installs. That reading is exactly how it stayed broken.
    expect(enabled).toBe(false)
  })
})
