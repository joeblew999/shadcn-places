# Working towards full world coverage

Status: 2026-09-10. Five sources integrated. Countries complete, subdivisions
strong in 19 languages and improving, cities transformed but still the gap.

## Where it stands

Read `named` for a Latin-script language and `translated` for every other. The
distinction is not pedantry: "Brazil" in Vietnamese is "Brazil", so `translated`
counts a correct name as missing, while for Thai a Latin string is genuinely
unreadable and `translated` is the only honest figure. `/api/coverage/{locale}`
returns `latinScript` so a caller knows which to read.

| | countries (257) | subdivisions (5,304) | cities (34,135) |
| --- | --- | --- | --- |
| **ja / ru / ar / ko** | 100% | 99% | 51 / 59 / 42 / 35% |
| **zh** | 100% | **97%** | 59% |
| **fa / uk** | 100% | 100% | 48 / 41% |
| **ur** | 100% | **90%** | 47% |
| **hi** | 100% | 96% | 26% |
| **bn / el** | 100% | **80%** | 25% |
| **th** | 100% | **77%** | 19% |
| **he** | 100% | **54%** | 28% |
| nl / pl / tr (Latin) | 100% | 100% | 67 / 49 / 40% |
| id / vi / ms (Latin) | 100% | **86 / 81 / 80%** | 28 / 37 / 9% |
| sw (Latin) | 100% | 45% | 20% |

**Subdivisions are effectively solved.** Every language above is 54% or better and
most are past 80% — including the ones no source had at all a day earlier. Running
the Wikidata label pass against subdivisions was what did it, and it was cheap:
dr5hn supplies a QID on 98% of them, so the lookup is by identifier rather than by
a property that happens to be filled in. 5,218 lookups, 109,849 labels, ninety
seconds.

For a Thailand-first product the practical position is now: **every country in
Thai, all 78 Thai provinces in Thai, and 83% of Thai cities in Thai.** Cities
elsewhere in the world are the remaining gap.

## The five sources, and what each is actually for

| Source | Licence | Earns its place by |
| --- | --- | --- |
| **CLDR** | Unicode | Countries, complete, in every locale ICU carries. Nothing else needed at that tier |
| **dr5hn** | ODbL | Subdivisions in 19 languages at ~100%. The best single subdivision source |
| **OpenStreetMap** | ODbL | Subdivisions in the languages dr5hn lacks — th, vi, id, sw, he, el, bn, ms. Joined on ISO 3166-2, which *is* our id |
| **GeoNames** | CC BY 4.0 | The city inventory, and every city in its own language: 83% for Thai cities in Thailand, 94% Japanese in Japan, 100% Russian in Russia |
| **Wikidata** | CC0 | Cross-language city names. 230,369 labels, and the difference between cities being unusable and usable |

Two of these were added on 2026-09-10 and both roughly doubled a tier.

## What the measurements kept getting wrong

Three times a coverage figure turned out to describe a filtered subset rather than
the world, and each time the filter was invisible in the number:

1. **Wikidata cities, first pass — too optimistic.** "84% Japanese for cities of
   15k–100k" measured items *carrying a population statement*: 6,451 of them,
   against ~30,000 real cities in that band. An item somebody curated a population
   onto is one somebody curated labels onto.
2. **Wikidata cities, second pass — too pessimistic.** Correcting the above, I
   measured 400 Brazilian towns and found three Japanese labels, then concluded
   cities could not be translated from open data at all. Those towns were
   15–50k people in one country. Run against the whole inventory: **51% Japanese.**
3. **The diagonal, reported as the headline.** "Thai cities: 83%" was Thai cities
   *in Thailand*. Worldwide it is 19%. Both matter and they are different
   questions; only one of them was being asked.

The pattern is the same each time: a sample chosen for convenience, and a number
that carries no trace of how it was chosen. The scorer (`places score`) and the
coverage endpoint exist so the answer is measured against the actual inventory
rather than against whatever was to hand.

## What would move the needle next

- [x] **OSM for cities — measured, and not worth building.** The raw tag coverage
      looked excellent: Japanese cities carry `name:ko` and `name:zh` at 100%,
      `name:ru` at 73%, `name:th` at 64%. But measured as *incremental* value
      against what Wikidata already gave us, 1,372 matched Brazilian cities would
      gain 44 Russian names, 15 Chinese and 9 Japanese. Roughly a hundred names for
      250 Overpass queries and a join that has no key — cities carry no ISO code,
      and matching by name fails across scripts entirely (0 of 1,067 Thai nodes
      matched, because OSM's `name` is in Thai and ours is romanised).

      The lesson is the one this project keeps relearning: a source's coverage is
      not its contribution. OSM is excellent at naming cities and almost entirely
      overlaps with a source we already have.
- [x] **Wikidata for subdivisions.** Done 2026-09-10 and it was the largest single
      gain of the day: th 20→77%, vi 25→81%, id 35→86%, zh 55→97%, and bn/el/ms
      from a quarter to four fifths. Joined on the QID dr5hn ships, which covers
      98% of rows.
- [x] **More cities — done, and it improved both axes.** Moved from `cities15000`
      to `cities5000`: **34,135 places to 69,700**. Every coverage percentage fell,
      exactly as predicted, because a town of 8,000 has fewer translations than a
      city of 200,000 — `ja` 51→40%, `ru` 59→51%, `th` 19→11%.

      And that framing is wrong, which is worth recording. Absolute translated
      names went **310,478 → 513,481, up 65%**, and the diagonal — a city named in
      its own country's language, which is what a locally-used product needs —
      *improved*: Thai 83→89%, Vietnamese 47→65%, Korean 69→85%. The smaller towns
      GeoNames added do have local names.

      A percentage fell while every real measure rose. Anyone reading the coverage
      table in isolation would conclude the opposite, which is why `total` is
      reported beside it.

- [ ] **`cities500`,** 220,000 places, if the same trade holds. Worth measuring the
      diagonal on a sample before committing: the argument above only works while
      the added places still carry local names.
- [ ] **Transliteration.** Still the only thing that can help `th`, `zh` and `ko`
      for the long tail, and still a research problem rather than a feature: `Intl`
      has no transliterator, and going from Portuguese spelling to Thai script is
      not a rule anyone has written down. Not attempted rather than attempted badly.
