# Plan — a language picker that reads the data, and a component for the matrix

Status: **done 2026-09-10.** All six steps built, tested and deployed. Proof is
beside each box.

## The problem

**The demo's language list is hardcoded.** Twelve locales, typed into
`public/index.html`, chosen by me because they made a good demonstration:

```js
const LOCALES = [["en","English"], ["th","ไทย"], ["ja","日本語"], …]
```

That is the exact thing this service exists not to have. The database holds names
in **664 locales**; the picker offers twelve, and the twelve are a list somebody
has to remember to edit. A service whose whole argument is "there is no language
list, ask for what you want" is being demonstrated by a page with a language list
in it.

## What it could be driven off — and they are different questions

There is no single right answer, which is why this needs deciding rather than
assuming:

| Driven by | Shows | Right when |
| --- | --- | --- |
| **What the data has** | every locale with any coverage — 664 | you are exploring the service |
| **What the data has *well*** | locales above a coverage threshold for the tier being shown | you are picking a language to actually read in |
| **Reader population** | biggest languages first, from `data/speakers.json` | you are choosing what a product should offer |
| **The reader's own browser** | `navigator.languages`, negotiated against coverage | a real product, showing one person their own language |
| **The consumer's declared set** | whatever the embedding app supports | the picker is inside somebody else's product |

The last one matters most for adoption: **remy-sport has 27 declared locales and
does not want a picker offering 664.** So the component takes the list as a prop
and defaults to fetching it — the same shape as `locale` being a request
parameter rather than a build-time constant.

An endpoint is needed for the middle three: `/api/locales`, returning each locale
with its coverage per tier and its reader count. The data already exists —
`/api/matrix` computes most of it — but it answers "what is broken" rather than
"what can I offer", and those want different shapes.

## The second component: making the matrix legible

`places matrix` prints a table that is fine in a terminal and unreadable to
anyone deciding whether to adopt this. The interesting shape is a **heatmap**:
locales down, tiers across, colour by coverage, sorted by reader population — and
crucially the **diagonal** beside it, because "Thai cities 11%" and "Thai cities
in Thailand 89%" are both true and mean opposite things.

It should be a registry item like the picker, for a reason beyond tidiness:
anyone self-hosting this from the ODbL dumps needs to see their own coverage, and
a component they install is the only version of that which stays current.

## Steps

- [x] **1 · `/api/locales`** — every locale with coverage per tier and reader
      count. Distinct from `/api/matrix`, which ranks what is broken.
      *Proof: `GET /api/locales?min=70&tier=country` returns each locale with its
      endonym, English name, readers and per-tier coverage; asserted by
      "offers languages named in their own language" in `tests/api/service.test.ts`.*
- [x] **2 · The picker takes its list as a prop, and fetches when not given one.**
      Same principle as `locale` on every other call: the service holds everything,
      the caller narrows it.
      *Proof: `locales`, `onLocaleChange`, `localeMin` and `localeTier` on
      `PlacesPickerProps`. The language control renders only when `onLocaleChange`
      is given — a control nothing listens to is worse than no control — and the
      list is fetched only when `locales` is absent, so an app passing its own
      twenty-seven never pays for the call. `example/src/Typed.tsx` drives it.*
- [x] **3 · Endonyms.** A language picker names languages in their own language.
      *Proof: `endonymOf` in `src/index.ts`, with `tl` mapped to `fil` because ICU
      answers in English for `tl` rather than erroring. Asserted for `ja` → 日本語
      and `th` → ไทย.*
- [x] **4 · Replace the demo's hardcoded twelve** with it.
      *Proof: `public/index.html` calls `/api/locales?min=40&tier=country&by=readers`
      and builds the `<select>` from the answer. The twelve are gone.*
- [x] **5 · The coverage heatmap as a registry item** — locales × tiers, coloured,
      reader-weighted, with the diagonal beside it.
      *Proof: `src/web/places-coverage.tsx`, exporting `PlacesCoverage` and
      `PlacesDiagonal`, served at `/r/places-coverage.json` and installed by the
      opt-in install test, which then compiles it under a consumer's tsconfig.
      Three colour bands rather than a gradient, because the difference between
      61% and 64% is one source's release and reads as precision this data has not
      got.*
- [x] **6 · A check that no locale list is hardcoded anywhere.**
      *Proof: "nothing hardcodes a list of languages" in
      `tests/repo/registry.test.ts`. `NON_LATIN_SCRIPT` was on its allowlist and
      has since been deleted rather than exempted — it was a hand-typed list of
      fifty that had fallen thirty-nine behind the data, which is exactly what the
      check exists to catch, sitting inside the check's own exemption.*

## What building it changed about the plan

**The picker does not fetch at all, if you would rather it did not.** The plan
asked only for the language list to be a prop. Building `example/src/Typed.tsx`
against `@orpc/tanstack-query` made the wider version obvious: `countries`,
`subdivisions` and `cities` are props too, and any tier passed in skips its
fetch. The component becomes something that renders places rather than something
that knows how to get them, and it works under TanStack Query, SWR, a server
component or a test with fixtures.

It deliberately does **not** depend on TanStack Query itself. That would be less
code here and a hard runtime throw for any installer without a
`QueryClientProvider` above it — and the registry item is the one artefact that
lands in a stranger's project with nothing of ours to check what is around it.

**The diagonal is a component, not an endpoint.** `PlacesDiagonal` takes rows;
`places matrix` computes them from SQL. Adding a ninth procedure for a number
almost nobody queries would have been a served endpoint maintained for the demo
that displays it.

## Not in this plan

- **Which languages remy-sport should offer.** That is the adoption plan's
  question and it belongs in that repository.
