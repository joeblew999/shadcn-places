# The derived database

The data itself, not the code that builds it — published because **ODbL requires
it to be.** Publishing an ETL while keeping its output private would look like
compliance from the outside and would not be it.

**Licence: [ODbL-1.0](../LICENSE-DATA).** Using the hosted API imposes nothing on
you. Redistributing these files, or a database derived from them, does.

## Where it is

```
https://shadcn-places.gedw99.workers.dev/data/
```

| File | Rows | What it is |
| --- | --- | --- |
| `countries.ndjson.gz` | 257 | Unicode CLDR, plus Wikidata for the 140 languages ICU does not carry |
| `subdivisions.ndjson.gz` | 5,304 | dr5hn (ODbL), GeoNames (CC BY) and OpenStreetMap (ODbL) |
| `cities.ndjson.gz` | 69,700 | GeoNames inventory; names from Wikidata and OpenStreetMap |
| `history.ndjson.gz` | one line per publish | What changed, and when — see `places history` |

## Why a URL and not this directory

These files were committed until 2026-09-10. gzip is already compressed, so git
cannot delta it: every publish stored a fresh 13.4MB **permanently**. `.git`
reached 134MB and was mostly twelve copies of `cities.ndjson.gz`, and this
repository has already had to `git-filter-repo` a 76MB blob out of its history
once.

ODbL says *make available*. It does not say *in git*, and the URL discharges it
better — `tests/api/service.test.ts` downloads the database on every deploy and
checks it against the committed checksums, where a commit could only be asserted.

**[`manifest.json`](manifest.json) stays committed**: filenames, byte counts,
SHA-256 and the commit they were built from. Git keeps the claim; R2 keeps the
bytes, and the two are verified against each other.

```bash
# what a checkout does to get the database
bun run places baseline     # downloads and verifies against manifest.json

# or just take it
curl -O https://shadcn-places.gedw99.workers.dev/data/cities.ndjson.gz
```

A download whose SHA-256 disagrees with the manifest is **refused**, not warned
about: the alternative is a diff computed against bytes no commit vouched for,
reporting changes that did not happen and losses that did.

One NDJSON object per line:

```json
{"id":"subdivision:BR-SP","type":"subdivision","pivot":"São Paulo","country":"BR",
 "names":[{"locale":"ja","value":"サンパウロ州","source":"dr5hn","kind":"translated","alternatives":0}]}
```

`kind` is the field to read before trusting a name. `translated` means a source
called it a translation — never that a human read it. `romanised` means the value
is identical to the pivot, which for a Latin-script language is correct and for
Thai or Japanese means nobody has translated it.

**Cities are largely untranslated and that is not a gap we can close.** Measured
against 400 real Brazilian cities, Wikidata carries 296 English labels, 10
Portuguese and 3 Japanese. There is no open source that does better. See
`docs/done/2026-09-10-01-first-build.md` for how a much rosier figure turned out to
have measured a filtered subset.

Rebuild any of this with `bun run places stage && bun run places extract && bun run places merge`.
