/**
 * One command, dispatching. Not a task per verb.
 *
 * Borrowed deliberately from the repository this grew out of, where the lesson was
 * learned the expensive way: a script per verb grows a name a person has to know
 * exists, until nothing can be found. Starting with a dispatcher costs nothing
 * now and is awkward to retrofit at fifteen commands.
 *
 *   bun run places                 what can be done
 *   bun run places stage --sample  fetch the small sources
 *   bun run places extract         stream them into rows
 */

export {} // this file is a script, and top-level await needs it to be a module

const OPS: Record<string, { help: string; run: (argv: string[]) => Promise<void> }> = {
  stage: {
    help: "stage [--sample] [source...]   fetch sources into .stage/ — the only step that downloads",
    run: async (argv) => (await import("./places/stage.ts")).stage(argv),
  },
  extract: {
    help: "extract [countries|subdivisions|cities]   stream staged sources into .build/*.ndjson — no network",
    run: async (argv) => (await import("./places/extract.ts")).extract(argv),
  },
  merge: {
    help: "merge                         resolve names per (place, locale) by kind precedence",
    run: async (argv) => (await import("./places/merge.ts")).merge(argv),
  },
  labels: {
    help: "labels [--country=BR] [--limit=N] [--locales=a,b]   city names from Wikidata, joined on P1566",
    run: async (argv) => (await import("./places/labels.ts")).labels(argv),
  },
  load: {
    help: "load                          write .build/load.sql for `wrangler d1 execute --file`",
    run: async (argv) => (await import("./places/load.ts")).load(argv),
  },
  report: {
    help: "report [locale...]            coverage per language, before adopting one",
    run: async (argv) => (await import("./places/report.ts")).report(argv),
  },
}

const [command, ...argv] = process.argv.slice(2)

if (!command || !OPS[command]) {
  if (command) console.error(`unknown command: ${command}\n`)
  console.log("shadcn-places — build the place data\n")
  for (const [name, op] of Object.entries(OPS)) console.log(`  ${op.help}`)
  console.log("\nThe order is stage → extract → merge. Only stage uses the network,")
  console.log("which is why adding a language is minutes rather than 1.2GB.")
  process.exit(command ? 1 : 0)
}

await OPS[command].run(argv)
