# One tag per language

Raised by the Product Owner: *"there are still HUGE gaps."* There were. Two of
them were bugs, not scarcity, and both had been reporting a language as absent
while its names sat in the table under a different name.

---

## Filipino was two half-populated languages

| tag | names | real |
| --- | --- | --- |
| `tl` | 2,543 | 1,043 |
| `fil` | 1,148 | 176 |

The request negotiation is `locale IN (locale, base)`. `fil` never reaches `tl`
and neither reaches the other, so a Filipino reader asking for `fil` got **0%
subdivisions** while **446 real Filipino subdivision names** sat under `tl`.

That is the `tl`/`fil` trap for the third time in this project — once in an
application's `Intl` calls, once in this service's endonym lookup, and now in the
data itself.

Four more languages were split the same way:

```
no  6,150 / nb  4,534      →  nb       9,134 names, 3,536 real
sh    660 / hbs   ...      →  sr-Latn  4,426 names, 1,376 real
als   207 / gsw   ...      →  gsw        484 names,   357 real
bh    159 / bho   163      →  bho        303 names,   303 real
```

### The table is CLDR's, not mine

The first fix was twelve alias entries typed by hand. The Product Owner asked
whether this was reinventing a wheel. It was.

`cldr-core` ships **five hundred** language aliases, maintained, with a reason on
each — and agreed with eleven of my twelve. It also carries every ISO 639-2/3
three-letter code my list missed entirely: `deu`→`de`, `fra`→`fr`, `zho`→`zh`,
`gre`→`el`, `per`→`fa`.

That would have been the third hand-typed language list in one file. The first was
`NON_LATIN_SCRIPT`: fifty codes, missing thirty-nine.

`places aliases` generates the compact 6KB form into
`src/api/locale-aliases.json` — the raw file is 137KB and mostly territory, script
and zone aliases this service has no use for. Committed so a clone needs no
generation step; a repo test regenerates it and fails if the two diverge.

### The two entries that override CLDR, and why

Both verified against the actual values rather than assumed:

**`als` → `gsw`, not `sq`.** CLDR says `als` is Tosk Albanian. Our values are
"Kanton Jura", "Wil SG", "Veyrier GE" — **Wikipedia uses `als` for Alemannic
German.** Applying CLDR's alias would have filed German names under Albanian,
where the script check would have called every one of them a real translation.

**`no` → `nb`.** CLDR has no alias, correctly: `no` is the Norwegian
macrolanguage. Every value our sources give it is Bokmål.

### Canonicalised once, in the merge

The same argument as `coverage.latin`: the merge and the Worker must agree, and
the only way two processes agree about a derived fact is for one to derive it and
the other to read it. `resolve()` canonicalises on ingest so the database holds
one tag per language; `tags()` canonicalises the request so a caller asking for
`tl` is answered from `fil`.

A static committed table rather than `Intl.getCanonicalLocales`, which answers
differently in Bun, Node and workerd.

### The gate stopped the rebuild, correctly

```
STOPPING: this build loses 18503 place(s).
```

The losses were the renames — `no-4851`/`nb+3899`, `tl-1893`/`fil+1786` — and the
shortfall between them is duplicate `(place, language)` pairs collapsing, which is
the entire point. Verified before forcing: counting real names per **canonical**
locale, nothing went down that was not two rows for one place-language becoming
one, and the total moved **875,818 → 896,103**.

---

## 140 languages had no country names at all

The README said countries were *"100%, every locale ICU carries"*. True, and
carrying a lot of weight: CLDR covers the hundred-odd locales ICU ships.

**Wu (81M readers) and Cantonese (77M) had zero country names.** So did Min Nan,
Hakka, Egyptian Arabic, Tatar, Chechen — 140 base languages holding 100+ real
place names each and not one country between them. The matrix duly ranked them as
the worst gaps on earth, which is the failure this project is organised against:
an absence of *fetching* recorded as an absence in the world.

Wikidata has them, and every country carries P297 — its ISO 3166-1 alpha-2 code,
which **is** our country id. The join is exact and needs no matching. 257 places
in one query rather than 279 batches, so `places labels --countries`
short-circuits before the city pass's machinery.

```
countries   19,532 names  →  46,269 names
wuu   0%  →  98%          yue   0%  →  98%
```

---

## What is left is scarcity, and should not be confused with this

Swahili subdivisions 45%. Filipino 12%. Cities 17–59% for every language that
needs translating. **No source has those names.** They are not a bug, they will
not be fixed by a better join, and the only remaining lever for non-Latin scripts
is transliteration — a research problem, tracked in
[world coverage](2026-09-10-03-world-coverage.md).

The difference matters. Everything in this document was a name we already had,
filed where nobody could find it.

---

## And the plans now say what is true

Two documents sat with seventeen unticked boxes for work that had shipped — one of
them filed under `done/` claiming its own subject was unbuilt. The Product Owner
could not tell what was done because I had not ticked them.

- [why these sources](done/2026-09-09-why-these-sources.md) — 13 steps, 12 built,
  1 deferred. Ticked with proof beside each; moved to `done/`.
- [the first build](done/2026-09-10-01-first-build.md) — 5 steps, 4 built, 1
  deferred. Ticked; status corrected.
- [world coverage](2026-09-10-03-world-coverage.md) — the only plan left with open
  steps.

`docs/README.md` now opens with the count, so the question "what is done" is
answered before anything has to be read.
