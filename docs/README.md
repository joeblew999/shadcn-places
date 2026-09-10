# Project work — start here

`docs/` holds the working record: the plans, the reasoning, and what has gone
wrong. The README is for somebody deciding whether to use this; everything about
*how it is built* is here.

## Working rules

- Start from the owning document below. Record status and evidence there.
- **Finished work moves to [`done/`](done/).** A document stays in `docs/` while
  it still has an open item in it. When the last one closes, move the file — the
  top level is then a list of what is actually left rather than a list of
  everything that ever happened.
- `bun run places sync` is the pipeline. Its order is load-bearing and the reason
  for each step is in [the CLI record](done/2026-09-10-06-the-cli-and-the-platform.md).
- A measurement without its denominator is not a measurement. This project has
  been caught five times by a number that answered a narrower question than the
  one being asked; they are all recorded rather than quietly fixed.

## Open

| Work | State | What it holds |
| --- | --- | --- |
| [World coverage](2026-09-10-03-world-coverage.md) | Countries done, subdivisions strong, cities the gap | What each language actually has and what would move it. OSM for cities was measured and rejected on incremental value, then re-measured and accepted once the join was fixed — and is now folded in. |
| [GUI driven by the matrix](2026-09-10-04-gui-driven-by-the-matrix.md) | Mostly built | `/api/locales`, endonyms and the demo's heatmap are done. Open: the picker taking its list as a prop, and the heatmap as a second registry item. |
| [Why these sources](2026-09-09-why-these-sources.md) | Reference; still current | Five candidates measured rather than read about, and the reasoning that picked each tier's winner. Two conclusions were later disproved by building; both corrections are inline. Stays here because it is consulted, not because it is unfinished. |

## Done

| Work | What it holds |
| --- | --- |
| [One answer per question](2026-09-10-07-one-answer-per-question.md) | The oRPC 2.0 migration, the Worker that was never typechecked, and the script classification being asked in three runtimes that disagree. |
| [The CLI and the platform](done/2026-09-10-06-the-cli-and-the-platform.md) | `places sync` and its ordering, and the eight Cloudflare/oRPC features that replaced things hand-rolled worse. Includes two failures that cost real time. |
| [Things that never worked](done/2026-09-10-05-things-that-never-worked.md) | The registry item, the typed client and the OpenAPI spec were all documented and all broken, and every check was green. What each check should have asserted. |
| [Rebuild strategy](done/2026-09-10-02-rebuild-strategy.md) | It rebuilds, it does not repair. `overrides.json` is the only kind a rebuild preserves; `places diff` is the safety net. |
| [The first build](done/2026-09-10-01-first-build.md) | How the ETL came together, and the streaming-parser bug that silently parsed 56 of 5,308 rows. |

## Still open

- **Cities are 17–59% translated** for the languages that need translation, and
  that is close to the ceiling of open data. Transliteration is the only thing
  left that could raise it for non-Latin scripts, and it is a research problem
  rather than a feature.
- **The heatmap as a registry item** — it is in the demo but not installable, so
  anyone self-hosting cannot see their own coverage.
- **The picker taking its locale list as a prop** — it is still deciding for the
  caller, which is the one thing this service exists not to do.
- **`@orpc/tanstack-query` for the picker** — the one remaining unused package
  from the oRPC Cloudflare playground that solves a problem this has.
  `@orpc/hibernation` and `@orpc/publisher` do not.
- **No history.** `places diff` compares against the last publish, not against
  every publish, so "when did this name change?" has no answer.

## The other half

[Adopting shadcn-places](https://github.com/joeblew999/remy-sport/blob/main/docs/2026-09-10-01-adopting-shadcn-places.md)
lives in the application that will consume this, and asks the question this
repository cannot: what does *it* stop owning. Nothing there depends on this
service yet, deliberately.
