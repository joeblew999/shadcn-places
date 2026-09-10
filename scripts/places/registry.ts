/**
 * Build the registry items that are actually served, with the source inside them.
 *
 * `registry.json` is an authoring manifest: it names files by path, which is
 * meaningful in this repository and meaningless to somebody's `shadcn add`. The
 * item served over HTTP has to carry the file **content**, because the installer
 * has no other way to get it.
 *
 * Mine did not. `shadcn add https://…/r/places-picker.json` fetched the item,
 * installed button, command, dialog and popover — and silently skipped the
 * component itself, because there was nothing to write. It exited zero and
 * printed a success. The one thing this project asks people to install had never
 * once installed, and the repo check passed throughout because it verified the
 * path existed *here*.
 *
 * So the served items are generated, and the check now reads what is served.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, resolve as resolvePath } from "node:path"

const ROOT = resolvePath(import.meta.dirname, "../..")

interface Item {
  name: string
  type?: string
  title?: string
  description?: string
  registryDependencies?: string[]
  dependencies?: string[]
  files?: { path: string; type?: string; target?: string }[]
  docs?: string
}

export async function registry(_argv: string[]): Promise<void> {
  const manifest = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8")) as {
    name: string
    homepage?: string
    items: Item[]
  }
  mkdirSync(join(ROOT, "public"), { recursive: true })

  for (const item of manifest.items) {
    const files = (item.files ?? []).map((f) => ({
      // `path` stays for readability, but `content` is what the installer uses.
      path: f.path,
      type: f.type ?? "registry:component",
      target: f.target,
      content: readFileSync(join(ROOT, f.path), "utf8"),
    }))

    const built = {
      $schema: "https://ui.shadcn.com/schema/registry-item.json",
      name: item.name,
      type: item.type ?? "registry:component",
      title: item.title,
      description: item.description,
      author: manifest.name,
      registryDependencies: item.registryDependencies ?? [],
      dependencies: item.dependencies ?? [],
      files,
      docs: item.docs,
    }

    const out = join(ROOT, "public", `${item.name}.json`)
    writeFileSync(out, JSON.stringify(built, null, 2) + "\n")
    const bytes = files.reduce((n, f) => n + f.content.length, 0)
    console.log(`  ${item.name}: ${files.length} file(s), ${(bytes / 1024).toFixed(1)}KB of source → public/${item.name}.json`)
  }
  console.log("\n  Served at /r/<name>.json. Install with:")
  console.log(`    bunx shadcn@latest add https://shadcn-places.gedw99.workers.dev/r/${manifest.items[0]?.name}.json`)
}
