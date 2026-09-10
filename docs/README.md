# Project work — start here

`docs/` holds the working record: the plans, the reasoning, and what has gone
wrong. The README is for somebody deciding whether to use this; everything about
*how it is built* is here.

## Where things stand

Every plan in this repository is resolved except one. `docs/` holds what is left;
`done/` holds the rest, each with its boxes ticked and the proof beside them.

| | |
| --- | --- |
| Plans with open steps | **1** — [world coverage](2026-09-10-03-world-coverage.md), 2 steps |
| Plans complete | 6 |
| Records (no steps) | 4 |

## Working rules

- Start from the owning document below. Record status and evidence there.
- **Finished work moves to [`done/`](done/).** A document stays in `docs/` while
  it still has an open item in it. When the last one closes, move the file — the
  top level is then a list of what is actually left rather than a list of
  everything that ever happened.
- `bun run places sync` is the pipeline, and it ends by deploying and then testing
  what it deployed. Its order is load-bearing and every step carries its reason in
  [`scripts/places/sync.ts`](../scripts/places/sync.ts) — the code owns that order,
  so a document repeating it is a second answer waiting to go stale. The record of
  *why the command exists* is [the CLI record](done/2026-09-10-06-the-cli-and-the-platform.md).
- A measurement without its denominator is not a measurement. This project has
  been caught five times by a number that answered a narrower question than the
  one being asked; they are all recorded rather than quietly fixed.

## Open

| Work | State | What it holds |
| --- | --- | --- |
| [World coverage](2026-09-10-03-world-coverage.md) | **The only plan with open steps.** 3 of 5 done | What each language actually has and what would move it. Open: `cities500`, and transliteration — which is the one thing left that could move city coverage for non-Latin scripts, and is a research problem rather than a feature. |

## Done

| Work | What it holds |
| --- | --- |
| [One tag per language](2026-09-10-09-one-tag-per-language.md) | Filipino split across `tl` and `fil`, 140 languages with no country names at all, and a hand-written alias table replaced by CLDR's five hundred. |
| [Closing the open list](2026-09-10-08-closing-the-open-list.md) | The last four open items, and the four things they found — including a typed client that had never compiled in a consumer project. |
| [One answer per question](2026-09-10-07-one-answer-per-question.md) | The oRPC 2.0 migration, the Worker that was never typechecked, and the script classification being asked in three runtimes that disagree. |
| [GUI driven by the matrix](done/2026-09-10-04-gui-driven-by-the-matrix.md) | The language picker driven by the data rather than by a list, and the coverage heatmap as a second registry item. All six steps ticked with their proof. |
| [The CLI and the platform](done/2026-09-10-06-the-cli-and-the-platform.md) | `places sync` and its ordering, and the eight Cloudflare/oRPC features that replaced things hand-rolled worse. Includes two failures that cost real time. |
| [Things that never worked](done/2026-09-10-05-things-that-never-worked.md) | The registry item, the typed client and the OpenAPI spec were all documented and all broken, and every check was green. What each check should have asserted. |
| [Rebuild strategy](done/2026-09-10-02-rebuild-strategy.md) | It rebuilds, it does not repair. `overrides.json` is the only kind a rebuild preserves; `places diff` is the safety net. |
| [The first build](done/2026-09-10-01-first-build.md) | How the ETL came together, and the streaming-parser bug that silently parsed 56 of 5,308 rows. All five steps resolved. |
| [Why these sources](done/2026-09-09-why-these-sources.md) | Five candidates measured rather than read about, and the reasoning that picked each tier's winner. **Still the reference for why each source is here** — it lives in `done/` because its thirteen steps are resolved, not because it stopped being useful. |

## Still open

- **Cities are 17–59% translated** for the languages that need translating, and
  that is close to the ceiling of open data. Transliteration is the only thing
  left that could raise it for non-Latin scripts, and it is a research problem
  rather than a feature. A known limit, not a task.

Everything else on this list is done: the heatmap ships as
[`places-coverage`](done/2026-09-10-04-gui-driven-by-the-matrix.md), the picker
takes its language list — and its rows — as props, `@orpc/tanstack-query` drives
`example/src/Typed.tsx`, and `places history` answers when a name changed and to
what. See [closing the open list](2026-09-10-08-closing-the-open-list.md).

## The other half

[Adopting shadcn-places](https://github.com/joeblew999/remy-sport/blob/main/docs/2026-09-10-01-adopting-shadcn-places.md)
lives in the application that will consume this, and asks the question this
repository cannot: what does *it* stop owning. Nothing there depends on this
service yet, deliberately.
