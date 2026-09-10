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
  aliases: {
    help: "aliases                       regenerate the CLDR language alias table",
    run: async (argv) => (await import("./places/aliases.ts")).aliases(argv),
  },
  baseline: {
    help: "baseline                      fetch the last published database, verified against the manifest",
    run: async (argv) => {
      const { fetchBaseline } = await import("./places/baseline.ts")
      const manifest = await fetchBaseline()
      if (manifest) console.log(`  baseline ${manifest.at}${manifest.sha ? ` (${manifest.sha})` : ""}, ${manifest.files.length} files verified`)
    },
  },
  "labels-push": {
    help: "labels-push [--dry-run]       push .build/labels to R2, so they exist off this machine",
    run: async (argv) => (await import("./places/labels-push.ts")).labelsPush(argv),
  },
  publish: {
    help: "publish [--dry-run]          push the database to R2 and write data/manifest.json",
    run: async (argv) => (await import("./places/publish.ts")).publish(argv),
  },
  registry: {
    help: "registry                      build the served registry items, with the source inside them",
    run: async (argv) => (await import("./places/registry.ts")).registry(argv),
  },
  sync: {
    help: "sync [--full] [--force] [--dry-run] [--local-only] [--no-deploy]   pull → merge → diff → load → publish → deploy → verify",
    run: async (argv) => (await import("./places/sync.ts")).sync(argv),
  },
  pull: {
    help: "pull [--refresh]              bring the scheduled refresh's findings back from R2",
    run: async (argv) => (await import("./places/pull.ts")).pull(argv),
  },
  merge: {
    help: "merge                         resolve names per (place, locale) by kind precedence",
    run: async (argv) => (await import("./places/merge.ts")).merge(argv),
  },
  score: {
    help: "score [candidate...] [--locales=a,b]   would a third-party dataset serve these languages?",
    run: async (argv) => (await import("./places/score.ts")).score(argv),
  },
  labels: {
    help: "labels [--gaps] [--countries|--subdivisions] [--locales=a,b]   names from Wikidata; --gaps asks the matrix what is missing",
    run: async (argv) => (await import("./places/labels.ts")).labels(argv),
  },
  diff: {
    help: "diff [tier...]                what a rebuild changed against the published data",
    run: async (argv) => (await import("./places/diff.ts")).diff(argv),
  },
  history: {
    help: "history [locale|id|text] [--append]   when a name changed, and to what",
    run: async (argv) => (await import("./places/history.ts")).history(argv),
  },
  osm: {
    help: "osm [--refresh] [--extract-only] [CC...]   city names from OpenStreetMap, matched by coordinate",
    run: async (argv) => (await import("./places/osm.ts")).osm(argv),
  },
  load: {
    help: "load [--delta]                 write .build/load.sql; --delta touches only what changed",
    run: async (argv) => (await import("./places/load.ts")).load(argv),
  },
  speakers: {
    help: "speakers [--refresh]          literate readers per language, from CLDR, and where they are",
    run: async (argv) => (await import("./places/speakers.ts")).speakers(argv),
  },
  matrix: {
    help: "matrix [--remote] [--top=N] [locale...]   what the database has and has not, ranked",
    run: async (argv) => (await import("./places/matrix.ts")).matrix(argv),
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
  console.log("\n  Most of the time you want `sync`: it runs pull → merge → diff → load →")
  console.log("  apply → publish in that order, and stops if the build loses places.")
  console.log("\n  The individual steps are there for when something has gone wrong.")
  console.log("  Only `stage` and `osm` use the network for bulk data, which is why")
  console.log("  adding a language costs minutes rather than 1.2GB.")
  process.exit(command ? 1 : 0)
}

await OPS[command].run(argv)
