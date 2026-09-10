# Plan — a language picker that reads the data, and a component for the matrix

Status: proposed 2026-09-10. Nothing built. Raised by the Product Owner while the
matrix work was landing.

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

- [ ] **1 · `/api/locales`** — every locale with coverage per tier and reader
      count. Distinct from `/api/matrix`, which ranks what is broken.
- [ ] **2 · The picker takes its list as a prop, and fetches when not given one.**
      Same principle as `locale` on every other call: the service holds everything,
      the caller narrows it.
- [ ] **3 · Endonyms.** A language picker names languages in their own language —
      a reader who cannot read the current interface still has to find theirs.
      `Intl.DisplayNames(locale, {type:"language"})` gives all of them free, which
      is the same trick the country names use. Note `tl` resolves to `en-US`
      through ICU and needs mapping to `fil`.
- [ ] **4 · Replace the demo's hardcoded twelve** with it, which is the honest
      test: the demo stops being a page I curated and becomes one the data drives.
- [ ] **5 · The coverage heatmap as a registry item** — locales × tiers, coloured,
      reader-weighted, with the diagonal beside it.
- [ ] **6 · A check that no locale list is hardcoded anywhere.** This is the
      failure that recurs: it happened in the ETL (a locale list in `extract`), in
      the scorer (importing remy-sport's `ALL_LOCALES`), and now in the demo. Three
      times, three different files, same mistake.

## Not in this plan

- **Which languages remy-sport should offer.** That is the adoption plan's
  question and it belongs in that repository.
