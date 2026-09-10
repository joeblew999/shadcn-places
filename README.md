# shadcn-places

Countries, states and cities — **in every language the open data actually has** —
behind one API, with a cascading picker you install from a shadcn registry.

> Not affiliated with [shadcn/ui](https://ui.shadcn.com). The name follows the
> community convention of `shadcn-admin`, `shadcn-vue` and `shadcn-svelte`.

---

## Licence, in the ten seconds you have

Every other `shadcn-*` project is MIT throughout. This one is **not**, and the
difference only bites in one direction:

| What you do | What it costs you |
| --- | --- |
| **Call the hosted API** | **Nothing.** You are consuming a Produced Work, not creating a Derivative Database. Your app does not become ODbL. |
| **Install the picker component** | **Nothing.** The code is MIT. |
| **Redistribute the database** — self-host from our dumps, ship the rows in your own product | **ODbL applies.** Share-alike: offer your derived database under ODbL too. |

**Code: [MIT](LICENSE). Data: [ODbL-1.0](LICENSE-DATA).** They are separate
statements because they are separate things.

Data credits: [GeoNames](https://www.geonames.org) (CC BY 4.0),
[dr5hn/countries-states-cities-database](https://github.com/dr5hn/countries-states-cities-database)
(ODbL-1.0), **© [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors**
(ODbL-1.0), [Wikidata](https://www.wikidata.org) (CC0), and
[CLDR](https://cldr.unicode.org) (Unicode).

---

## What it actually contains

Not "every place in every language" — that does not exist in open data, and
anything claiming otherwise is machine-translated or English wearing a locale tag.
What exists:

| | Rows | Coverage |
| --- | --- | --- |
| **Countries** | 280 | **100%, every locale ICU carries.** The only complete tier |
| **Subdivisions** | 5,308 | 100% in 19 languages, plus each one in its own language |
| **Cities** | 34,135 | **A romanised name, and usually nothing else.** See below — this is the tier open data does not have |

Every name carries a **`kind`** — `translated`, `native`, `romanised`,
`transliterated` — and the **source** it came from. So you always know whether
you are reading a real translation or a fallback, and so do we.

### Cities are not translated, and no open source fixes that

Measured against 400 real Brazilian cities, joined to Wikidata on `P1566` (305
matched, so the join is sound): **296 English labels, 10 Portuguese, 3 Japanese,
1 Russian.**

An earlier version of this file claimed 83–99% cross-language coverage for cities.
That figure was measured over Wikidata items *carrying a population statement* —
6,451 in the 15k–100k band, against roughly 30,000 real cities in it — so it had
narrowed to the fifth of the world Wikidata knows best. An item somebody curated
a population onto is the item somebody curated labels onto. The number was true
and described the wrong population.

For a Latin-script reader this costs nothing: "Ourinhos" is what a Portuguese,
German or Vietnamese reader writes anyway. For Thai, Japanese, Korean, Chinese,
Arabic or Russian it means Latin characters inside the sentence for essentially
every city on earth — which is why transliteration is on the roadmap as the only
answer that exists, not as a refinement.

Ask `/api/coverage/{locale}` rather than trusting any of this.

## Live

**https://shadcn-places.gedw99.workers.dev**

```bash
curl "https://shadcn-places.gedw99.workers.dev/api/countries?locale=th"
curl "https://shadcn-places.gedw99.workers.dev/api/countries/BR/subdivisions?locale=ja"
curl "https://shadcn-places.gedw99.workers.dev/api/countries/BR/cities?q=our&locale=ja"
curl "https://shadcn-places.gedw99.workers.dev/api/coverage/th"
```

That last one is the honest endpoint: ask it what a language actually has before
you depend on it. Thai today is 280/280 countries and nothing below.

## Quick start

```bash
# the picker, into any shadcn project
bunx shadcn@latest add https://shadcn-places.gedw99.workers.dev/r/places-picker.json
```

```ts
// the typed client, from a Worker on the same account
import { createPlacesClient } from "shadcn-places/client"
const places = createPlacesClient({ fetch: env.PLACES.fetch }) // or a URL

await places.countries.list({ locale: "sw" })
await places.subdivisions.list({ country: "BR", locale: "ja" })
await places.cities.search({ country: "BR", subdivision: "SP", q: "our", locale: "ja" })
```

The same client points at a URL for anyone else's runtime, and there is an
OpenAPI document for anything that is not TypeScript.

`locale` is a request parameter, never a build-time list: the service stores every
language its sources carry, and you ask for the one you want. Adding a language to
*your* app costs this service nothing.

## Why the picker cascades

Country → subdivision → city, each step filtered by the one above. Not only
because 152,970 undifferentiated cities is a bad control, but because D1 bills
rows *scanned*: `name LIKE '%bangkok%'` unfiltered reads every row in the table,
per keystroke. Filtered and prefix-matched, it reads a handful. The cheap shape
and the usable shape are the same shape.

## Development

```bash
bun install
bun run places            # what the CLI can do
bun run places stage      # fetch sources into R2 (~1.2GB, rarely)
bun run places extract    # stream them into NDJSON — no network
bun run places merge      # one row per place, names with provenance
bun run places report     # coverage per language
bun run check             # typecheck, lint, tests
```

`stage` is the only step that downloads. Everything after it is a pure function of
what is already staged, which is why adding a language is minutes rather than a
rebuild.

See [docs/](docs/README.md) for the plans and [AGENTS.md](AGENTS.md) for how to
work here.
