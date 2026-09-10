# The derived database

This is the data itself, not the code that builds it — and it is here because
**ODbL requires it to be.** Publishing an ETL while keeping its output private
would look like compliance from the outside and would not be it.

**Licence: [ODbL-1.0](../LICENSE-DATA).** Using the hosted API imposes nothing on
you. Redistributing these files, or a database derived from them, does.

| File | Rows | What it is |
| --- | --- | --- |
| `countries.ndjson.gz` | 280 | From Unicode CLDR, in every locale ICU carries |
| `subdivisions.ndjson.gz` | 5,304 | From dr5hn (ODbL) and GeoNames (CC BY) |
| `cities.ndjson.gz` | 34,135 | GeoNames inventory; names mostly romanised — see below |

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
