# shadcn-places

Countries, states and cities — **in every language the open data actually has** —
behind one API, with a cascading picker you install from a shadcn registry.

**[Try it](https://shadcn-places.gedw99.workers.dev)** ·
**[API docs](https://shadcn-places.gedw99.workers.dev/api)** ·
**[OpenAPI](https://shadcn-places.gedw99.workers.dev/api/spec.json)**

> Not affiliated with [shadcn/ui](https://ui.shadcn.com). The name follows the
> convention of `shadcn-admin`, `shadcn-vue` and `shadcn-svelte`.

## Licence, in the ten seconds you have

Every other `shadcn-*` project is MIT throughout. This one is not, and the
difference only bites in one direction:

| What you do | What it costs you |
| --- | --- |
| **Call the hosted API** | **Nothing.** You are consuming a Produced Work, not creating a Derivative Database. Your app does not become ODbL. |
| **Install the picker** | **Nothing.** The code is MIT. |
| **Redistribute the database** — self-host from our dumps, ship the rows in your own product | **ODbL applies.** Share-alike: offer your derived database under ODbL too. |

**Code: [MIT](LICENSE). Data: [ODbL-1.0](LICENSE-DATA).**

Data from [GeoNames](https://www.geonames.org) (CC BY 4.0),
[dr5hn](https://github.com/dr5hn/countries-states-cities-database) (ODbL),
**© [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors** (ODbL),
[Wikidata](https://www.wikidata.org) (CC0) and [CLDR](https://cldr.unicode.org).

## Install

```bash
# The cascading picker. One command per item — `shadcn add` reads a second URL as
# an item *name* inside the first registry, not as a second registry.
bunx shadcn@latest add https://shadcn-places.gedw99.workers.dev/r/places-picker.json

# Optional: what the data actually has, per language, ranked by readers affected.
bunx shadcn@latest add https://shadcn-places.gedw99.workers.dev/r/places-coverage.json
```

```ts
import { createPlacesClient } from "shadcn-places/client"

// A URL, or env.PLACES.fetch for a Worker on the same account — same client.
const places = createPlacesClient()

await places.countries.list({ locale: "sw" })
await places.subdivisions.list({ country: "BR", locale: "ja" })
await places.cities.search({ country: "BR", q: "our", locale: "ja" })
```

The picker decides nothing for you. `locales` is a prop — pass the languages your
app has actually translated rather than the 898 this holds — and so are
`countries`, `subdivisions` and `cities`, so TanStack Query or anything else can
own the fetching. [`example/src/Typed.tsx`](example/src/Typed.tsx) does exactly
that; [`example/src/App.tsx`](example/src/App.tsx) uses fifteen lines of `fetch`
and no packages of ours.

Every endpoint is also a plain `GET`:

```bash
curl "https://shadcn-places.gedw99.workers.dev/api/countries/BR/subdivisions?locale=ja"
curl "https://shadcn-places.gedw99.workers.dev/api/coverage/th"
```

`locale` is a request parameter, never a build-time list: the service holds every
language its sources carry and you ask for the one you want.

## What it actually contains

Not "every place in every language" — that does not exist in open data.

| | Rows | Coverage |
| --- | --- | --- |
| **Countries** | 257 | **100% in every locale ICU carries, plus 140 it does not** |
| **Subdivisions** | 5,304 | 77–100% for most languages |
| **Cities** | 69,700 | A romanised name always; 17–59% translated depending on language |

Every name carries a **`kind`** — `override`, `translated`, `native`, `romanised`,
`transliterated` — and the **source** it came from, so you always know whether you
are reading a real translation or a fallback.

**Ask rather than trust this table**: `/api/coverage/th` reports what a
language actually has, and `/api/matrix` ranks what is missing by how many readers
it affects.

## Documentation

**[How the ETL works](docs/how-the-etl-works.md)** is the one-page mechanism, with
a real place traced from download to published row. Everything about why each
source was chosen and what has gone wrong lives in **[docs/](docs/README.md)**.

## Development

```bash
bun install
bun run places          # what the CLI can do
bun run places sync     # the whole cycle, ending in a deploy and a check against it
bun run places history  # when a name changed, and to what
bun run check           # typecheck, repo checks, service tests
```

`sync` is the one to reach for. The individual steps exist for when something has
gone wrong. See [docs/](docs/README.md) for the pipeline and its rules.
