# Project work — start here

`docs/` holds unfinished work. Start from the owning plan, record status and
evidence there, and keep this index short.

| Work | State | Next step / owning plan |
| --- | --- | --- |
| Why these sources | Reference; measurements still current | [Why these sources](2026-09-09-why-these-sources.md). Five candidates measured rather than read about, and the reasoning that picked each tier's winner. Moved here from the remy-sport repository on 2026-09-10, since it argues for this service rather than for that application. Two of its conclusions were disproved by building; both corrections are inline. |
| World coverage | Five sources integrated; cities are the remaining gap | [Working towards full world coverage](2026-09-10-03-world-coverage.md). Countries complete everywhere; subdivisions 99% in the 19 languages dr5hn carries and 19–37% in the ones OSM fills; cities 51% ja, 59% ru, 19% th. Next: OSM for cities, Wikidata for subdivisions. Records three coverage figures that turned out to measure filtered subsets. |
| Rebuild strategy | Implemented | [How this stays correct when it is rebuilt](2026-09-10-02-rebuild-strategy.md). It rebuilds, it does not repair: full replace every run, with `overrides.json` as the only kind a rebuild preserves and `places diff` as the safety net. Open: no history, and no answer yet for a regression found by a 3am cron. |
| First build | ETL runs end to end; API and load not yet built | [The first build](2026-09-10-01-first-build.md). Countries, subdivisions and cities extract and merge from staged sources. Open: the Wikidata label join, the D1 load, the Worker, and the first publish. |

[Adopting shadcn-places](https://github.com/joeblew999/remy-sport/blob/main/docs/2026-09-10-01-adopting-shadcn-places.md)
is the other half, in the application that will consume this: what *it* stops
owning. Nothing there depends on this service yet, deliberately.
