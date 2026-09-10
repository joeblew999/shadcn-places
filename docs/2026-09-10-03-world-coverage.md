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

- [ ] **OSM for cities.** Probed and promising but unevenly: Japanese cities carry
      `name:th` 64%, `name:ru` 73%, `name:ko` and `name:zh` 100% — far past what
      GeoNames or Wikidata have. Brazil is 1–6%. The problem is the join: cities
      have no ISO code, and OSM's `wikidata` tag density runs 24% (Thailand) to
      99% (Japan). Worth doing where it is dense, and it needs ~250 Overpass
      queries rather than the single one subdivisions took.
- [x] **Wikidata for subdivisions.** Done 2026-09-10 and it was the largest single
      gain of the day: th 20→77%, vi 25→81%, id 35→86%, zh 55→97%, and bn/el/ms
      from a quarter to four fifths. Joined on the QID dr5hn ships, which covers
      98% of rows.
- [ ] **More cities.** `cities5000` is 55,000 rows against the current 34,135, and
      `cities500` is 220,000. More inventory means lower percentages and better
      answers — worth doing only once coverage of the current set stops improving.
- [ ] **Transliteration.** Still the only thing that can help `th`, `zh` and `ko`
      for the long tail, and still a research problem rather than a feature: `Intl`
      has no transliterator, and going from Portuguese spelling to Thai script is
      not a rule anyone has written down. Not attempted rather than attempted badly.
