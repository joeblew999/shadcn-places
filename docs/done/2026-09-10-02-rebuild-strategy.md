# How this stays correct when it is rebuilt

Status: 2026-09-10. Implemented — overrides, diff and the precedence stack all run.

The Product Owner asked whether the ETL "fixes the data as it goes". It does not,
and the honest description is worth writing down because the wrong mental model
leads to the wrong decisions about it.

## It rebuilds. It does not repair.

```
places stage    downloads          the only step that touches the network
places extract  every source → rows, every language kept
places merge    one name per (place, locale), by precedence
places diff     what changed against what we last published
places load     DELETE everything, then insert
```

`load.sql` opens with `DELETE FROM name; DELETE FROM place;`. Every run replaces
the database wholesale. Three properties follow:

- **Idempotent.** Run it twice, get the same database, not twice the rows.
- **Deterministic.** The merge picks winners by a rule, not by whichever source
  ran last, so the output does not depend on the order of the pipeline.
- **Cheap to repeat.** Only `stage` downloads. A new language re-runs `extract`
  over what is already on disk.

This is why re-running improves things when upstream improves — wiring GeoNames
into subdivisions took Thai provinces from 0 to 61 of 78 without touching a single
name by hand.

It is also why re-running degrades things when upstream degrades, silently, unless
something is watching.

## The precedence stack is the whole design

Every name carries a `kind`, and `kind` decides who wins:

| | | |
| --- | --- | --- |
| `override` | a human said so | **cannot be re-derived — the only kind a rebuild must preserve** |
| `translated` | a source claims a real translation | disposable; comes back on the next run |
| `native` | the place in its own language | disposable |
| `transliterated` | generated | must lose to any real name that appears later |
| `romanised` | the pivot, or a Latin string in a non-Latin language | the honest fallback |

Two consequences that are the point of the whole arrangement:

**Upstream improving flows in automatically.** Nobody has to notice that GeoNames
added Thai names last month; the next run picks them up and they outrank the
romanisation that was standing in.

**Upstream being wrong is what `overrides.json` is for.** dr5hn translates
Brazil's state of Acre as エーカー — the unit of area. That knowledge exists
nowhere upstream, so if it is not written down here it is lost on the next run.
Overrides outrank `translated` deliberately: deferring to a source we have already
established is wrong would defeat the purpose.

The distinction to hold onto: **add an override when a source is wrong, not when
it is absent.** A missing name is reported honestly as `romanised` and may arrive
upstream next month. A wrong name is served to a reader as though it were right,
and will not fix itself.

## `places diff` is the safety net, not a gate

A full replace means a bad upstream release lands without complaint — "fewer names
than last time" is not an error condition anywhere in the pipeline. So `diff`
compares a fresh build against the published artefacts in `data/` and reports
places gained and lost, names per locale, and the one thing a count cannot show:

**names that went from a real translation to a fallback.** Totals can hold
perfectly steady while quality falls — a source replaces a Thai name with a
transliteration and nothing moves. `kind` is what makes that visible, and it is
most of the reason `kind` exists.

It does not block. Some regressions are correct: filtering the deprecated country
aliases removed 23 places and that was the fix. A tool that refused to ship a
smaller number would have blocked it. Judgement stays with the person; `diff` only
makes sure they have the numbers.

## The loop

```
places stage        # rarely — when a source changes, not when a language is added
places extract
places merge        # overrides applied here, through the same ranking as everything else
places diff         # look. losses are a decision, not a surprise
places load
wrangler d1 execute places --remote --file=.build/load.sql
gzip -9 -c .build/*.merged.ndjson > data/    # publish what you just vouched for
```

`data/` is both the ODbL obligation and the diff's baseline, which is a useful
coincidence: the artefact we are required to publish is the same one that tells us
what changed, so it cannot rot without the check noticing.

## What this does not do yet

- **No history.** `diff` compares against the last publish, not against every
  publish. Answering "when did this name change?" would need the artefacts kept
  per version, which git already does — nothing reads them that way.
- **No alerting.** The refresh Workflow will need to decide what to do when a
  scheduled rebuild produces a large regression at three in the morning. Printing
  it to a log nobody reads is not an answer.
