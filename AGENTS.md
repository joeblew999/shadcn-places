# Working here

Short on purpose. What must hold is checked under `tests/repo/`, not remembered.

## What this is

A place database and an API, independent of any application. Countries,
subdivisions and cities, in **every language the sources carry** — not in a
language list configured somewhere, because there is no language list. A caller
passes `locale` at request time.

If you find yourself adding a list of supported languages, stop: that is the thing
this service exists not to have.

## The three rules that are not obvious

**1. Never hold a dataset in memory.** A Cloudflare isolate has 128 MB and the
limit cannot be raised. `JSON.parse` of a 44MB file produces an object graph
several times that. Everything streams — `scripts/lib/ndjson.ts` exists so no step
has to think about it twice. This is also why `stage` and `extract` are separate
commands.

**2. Never let a query scan the table.** D1 bills rows *scanned*, not returned,
and on a free plan the queries fail rather than slow once the daily limit is hit.
An unfiltered `LIKE '%x%'` over 152,970 cities is a full scan per keystroke. Every
lookup is scoped by a parent and matched by prefix, and the contract is shaped so
an unscoped query cannot be expressed.

**3. A name must say what it is.** Every name carries a `kind` — `translated`,
`native`, `romanised`, `transliterated`. A value identical to the romanised pivot
is `romanised` whatever its source called it. For a Latin-script language that is
correct and unremarkable; for Thai, Japanese or Russian it means nobody translated
it, and recording it as a translation turns an absence into a presence. The
project this grew out of had 31% of its non-Latin-script name cells holding the
English string while every completeness check passed.

## The pipeline

```
places stage    →  .stage/    someone else's data, up to 1.2GB, gitignored
places extract  →  .build/    one row per place, every language, no network
places merge    →  .build/    one name per (place, locale), by kind precedence
places report              coverage per language, before adopting one
```

`stage` is the only step that downloads. Everything after it is a pure function of
what is on disk — which is why **adding a language costs minutes, not a rebuild**.
GeoNames' alternate names file already contains every language on earth; a
language nobody has extracted yet is already staged.

## Licences are load-bearing here

The code is MIT and the data is ODbL, in two separate files, because dr5hn's
share-alike terms would otherwise make the React component share-alike and nobody
would adopt it. `tests/repo/licences.test.ts` holds that apart.

The derived rows must be published, not just the ETL. Publishing the code while
keeping the database private would look like compliance from outside and not be
it.

## Conventions

- **One CLI, dispatching.** `scripts/places.ts`. Not a script per verb.
- **Comments say why, not what.** A comment restating the code is noise; a comment
  recording the measurement or the failure that produced the code is the reason
  the next person does not undo it.
- **Plans go in `docs/`,** with the index kept current. What is not written down is
  invisible to whoever comes next.
