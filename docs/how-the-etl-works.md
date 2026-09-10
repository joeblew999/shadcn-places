# How the ETL works

Not why — every decision has a dated record for that. This is the mechanism, and
it is the document that was missing.

## Three directories, three lifetimes

```
.stage/     963 MB   other people's files, exactly as downloaded    gitignored
.build/     230 MB   working output, always rebuildable             gitignored
data/        14 MB   what we publish and what the API serves         COMMITTED
```

If `.stage/` and `.build/` are deleted, nothing is lost — `places stage` fetches
them again. If `data/` is deleted, the published database is gone and the ODbL
obligation with it.

## The pipeline splits in two, and that is the whole design

The two halves change at completely different rates, so they are separate steps
you run at separate times.

```
WHICH PLACES EXIST — changes rarely, costs 963 MB

  places stage      →  .stage/           GeoNames, dr5hn, OSM subdivisions
  places extract    →  .build/*.ndjson   one row per place, every name a source gave
                                         (no network: a pure function of .stage/)

WHAT THEY ARE CALLED — changes constantly, costs minutes

  places labels     →  .build/labels/*.ndjson   Wikidata, per language
  places osm        →  .build/labels/*.ndjson   OpenStreetMap, matched by coordinate
```

**Adding a language is the bottom half only.** `labels` then `sync`. Minutes, no
download. A new town is rare; somebody adding a Thai name to a Polish town happens
every day of the week, and the pipeline is shaped around that asymmetry.

`.build/labels/` currently holds 95 files. They are *additive* and named by a hash
of the locale set they cover, so a run for a new set of languages sits beside the
old ones instead of replacing them. It did replace them once, and twenty-five
languages of work disappeared without a word.

## One step decides. Everything above it only collects.

```
  places merge      →  .build/*.merged.ndjson
```

`merge` is the only place a name is chosen. For each `(place, language)` it takes
every candidate any source offered, and:

1. **canonicalises the tag** — `tl` and `fil` are one language, and were two
   half-populated ones until this existed
2. **works out what each name really is** — `translated`, `native`,
   `transliterated`, or `romanised`, by comparing against the pivot and checking
   the script, regardless of what the source claimed
3. **keeps the highest-ranked one**, by `KIND_RANK`

### Bangkok, all the way through

```
STEP 2  extract   103 names from the staged files.
                  Thai had FOUR candidates from GeoNames alone:
                    กรุงเทพมหานคร
                    กรุงเทพ
                    กรุงเทพฯ
                    กรุงเทพมหานคร อมรรัตนโกสินทร์ มหินทรายุธยา… (168 chars)

STEP 3  labels    3 more Thai candidates, from three separate Wikidata runs

STEP 4  merge     ONE Thai name survives:
                    กรุงเทพมหานคร   kind=translated   alternatives=6

                  103 names in → 156 out. The label files added 53 languages
                  Bangkok did not have.
```

`alternatives: 6` is the merge recording that it discarded six competing Thai
names. That number is *why* the pipeline is shaped this way: every earlier step is
allowed to be greedy and duplicative, because exactly one step resolves.

## Then it ships

```
  places diff     →  .build/change.json      compares against data/, BEFORE anything is written
  places load     →  .build/load.sql         a delta by default
        apply     →  D1 local, then remote   local is where a broken file is cheap
        publish   →  data/*.ndjson.gz        the ODbL artefact and the next diff's baseline
  places history  →  data/history.ndjson.gz  when a name changed, and to what
        deploy    →  the Worker and its assets
        verify    →  the service tests, against production
```

`places sync` runs all of that in order and **stops if the build loses places**.
Losses are sometimes correct — filtering the deprecated country aliases removed 23
and that was the fix — so it is a stop rather than a refusal, and `--force` is how
you say you meant it.

## What runs without you

```
  cron 17 3 * * SUN  →  the RefreshNames Workflow
```

It asks the coverage table which non-Latin languages are weakest, fetches names
for those from Wikidata, writes them to D1 **and to R2**. `places pull` brings the
R2 copy back into `.build/labels/` so the next local rebuild folds them in through
the same merge as everything else.

That second write is not redundancy. Without it the deployed database held 8,221
Thai names and the local build held 5,196 — and `load` opens by deleting, so the
next rebuild would have destroyed 3,025 names the schedule had found.

## The commands, in the order you would actually reach for them

| Situation | Command |
| --- | --- |
| Normal: improve and ship | `places sync` |
| Want more languages first | `places labels --gaps` then `places sync` |
| A source released a new version | `places stage` → `places extract` → `places sync` |
| Something looks wrong | `places matrix`, `places report <locale>`, `places history <what>` |
| Just looking | `places sync --dry-run` — stops after the diff |

## Why `.build/` is not in git and `data/` is

`.build/` is derived from `.stage/` plus the label files, and both are
reproducible. `data/` is the thing we vouch for: it is what the API serves, what
ODbL obliges us to publish, and what the next `diff` compares against. Published
with `gzip -n` so the same build produces the same bytes — without that, every
sync rewrote three binary blobs with identical contents and `git status` could not
tell a real change from a re-run.
