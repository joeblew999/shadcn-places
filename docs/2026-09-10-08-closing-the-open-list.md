# Closing the open list

Four items had been sitting under **Still open** in `docs/README.md`. All four are
done. Each one found something on the way, and three of the four findings are
worse than the item that found them.

---

## 1 · The picker takes its language list as a prop

`locales`, `onLocaleChange`, `localeMin`, `localeTier`. Omit `locales` and it asks
the service; pass twenty-seven and it offers twenty-seven.

Two decisions worth keeping:

**The control renders only when `onLocaleChange` is given.** A picker that lets
somebody change a setting nothing listens to is worse than one that does not offer
it.

**The list is fetched only when `locales` is absent.** An application passing its
own must never pay for a call it does not need.

And one that came out of building the TanStack example rather than out of the
plan: **`countries`, `subdivisions` and `cities` are props too.** Any tier passed
in skips its fetch, so the component works under TanStack Query, SWR, a server
component, or a test with fixtures. It renders places instead of knowing how to
get them. The built-in fetching is a convenience, not the contract.

---

## 2 · The heatmap is a registry item

`src/web/places-coverage.tsx` → `/r/places-coverage.json`. `PlacesCoverage` for
locales × tiers, `PlacesDiagonal` for the number a product serving one market
lives on.

**Three colour bands, not a gradient.** A continuous scale reads as precision this
data has not got — the difference between 61% and 64% is one source's release.
Three bands say the only thing anybody acts on: usable, patchy, or not really
there.

**Both numbers, always.** `named` and `translated`, with `latinScript` saying
which one means something. A single figure reports Spanish cities at 14% when a
Spanish reader gets a correct name for 51% of them, which is the mistake this
project has now made five times.

The diagonal is a component and not a ninth endpoint. `places matrix` computes it
in SQL; adding a procedure for a number almost nobody queries would be an endpoint
maintained for the demo that displays it.

### Two findings

**`registry/*.json` was a third copy of the manifest and nothing served it.**
`[assets] directory = "public"`, and the Worker strips `/r` and looks there. The
test asserting `registry/<name>.json` existed carried the comment *"the URL form
of the install would 404"* without it. That was false. Two hand-maintained copies
of one manifest, one of them dead, guarded by a test that checked they agreed —
the drift protection was real and the thing it protected was not. `registry/` is
deleted and the test reads what is actually served.

**`shadcn add <url-a> <url-b>` does not install two items.** It reads the first
argument as the registry and every later one as a *name* inside it, so the second
absolute URL is looked up as an item called `https://…` and fails with `[no such
registry item] undefined`. Each item needs its own invocation. The install test
now asserts both files exist, because the failure is silent and per item.

---

## 3 · `@orpc/tanstack-query`

`example/src/Typed.tsx`: `createPlacesClient` → `createTanstackQueryUtils` →
`useQuery`, driving the picker entirely through its data props.

`App.tsx` stays as it was — a hand-rolled `fetch` client, proving the API is
usable without any of our packages. Both need to be true and only one of them is
proof of the other.

The picker itself does **not** depend on TanStack Query. It would be less code and
a hard runtime throw for any installer without a `QueryClientProvider` above it,
and the registry item is the one artefact that lands in a stranger's project with
nothing of ours to check what is around it.

### The finding, and it is the worst one here

`example/` importing `shadcn-places/client` for the first time produced:

```
../src/client.ts(27,26): error TS5097: An import path can only end with a '.ts'
extension when 'allowImportingTsExtensions' is enabled
```

**The typed client has never compiled in a consumer project.** `src/client.ts`
imported `./api/contract.ts` with the extension, which requires a tsconfig flag
this repository sets and a consumer has no reason to.

Every test passed throughout. The service tests import the client and exercise it
over RPC — through *our* tsconfig, which proves it works here and says nothing
about there.

That is the fourth artefact this project published, documented, and never once
executed the way a stranger would, after the registry item, this same client's
existence, and the OpenAPI document. `tests/repo/package.test.ts` now walks every
entry in the export map, follows its relative imports, and fails on a `.ts`
extension or on a bare import that is in neither `peerDependencies` nor
`dependencies` — which also caught `@orpc/openapi`, imported by the published
contract and declared nowhere.

`peerDependencies` said `@orpc/contract: ">=1.15.0"` while the contract uses 2.0's
`.meta(openapi(...))`. Left over from the migration.

### And a version trap

`@orpc/client` has a published `2.0.0`. **None of the other eight packages do** —
they stop at `2.0.0-beta.35`, and npm's `latest` tag still points at 1.15.0 for
all nine. A `^2.0.0-beta.35` range therefore resolves `@orpc/client` to stable and
everything it shares internal types with to beta. Every range is pinned exactly
now, in both `package.json` files.

---

## 4 · History

`places diff` computed a full comparison on every run — every added name, every
demotion, every edited value — printed six lines and threw the rest away. So *when
did this name change* had no answer short of checking out old commits and
rebuilding, which nobody was ever going to do.

```
places history                    every publish, summarised
places history th                 per-publish delta and a running total
places history city:4887398       one place, before → after
places history "Kukës"            by name, for whoever does not know the id
```

`diff` writes `.build/change.json`, `sync` appends it **after** publishing —
because the history says what was *released*, and a run that stopped at the load
would otherwise describe a database nobody is serving.

**Additions are counts, not lists.** Today's OSM fold-in added 118,333 names and a
list of those is the database again rather than a record of it. Edits, demotions
and removals are kept in full, capped at 5,000 per publish per tier — and when the
cap bites, a query that finds nothing says *"absence here is not proof"* rather
than reporting silence as certainty.

The first entry is a genuine reconstruction: `PLACES_DATA` pointed at the previous
release, `places diff` recomputed exactly what that publish changed, and
`--sha --reconstructed` stamped it with the commit that shipped it. It renders
with a `~` and a footnote, because a derived entry passing itself off as
contemporary is worse than no entry.

### What the history immediately found

Its very first entry showed Tatar losing 503 names to fallback status, among them:

```
subdivision:DZ-06 tt: Medea      (translated) → (fallback)
city:4887398      tt: Çikago     (translated) → (fallback)
city:3369157      tt: Keyptawn   (translated) → (fallback)
```

These are not the same thing. "Çikago" and "Keyptawn" are somebody genuinely
writing Chicago and Cape Town in Tatar's Latin orthography. Both were being
labelled `romanised`, the bucket meaning *nobody has written this here*.

`actualKind` in `merge.ts` now folds accents away and compares against the pivot:
equal is `romanised`, different is `transliterated`. No coverage figure moves —
both are excluded either way — but a transliteration outranks a bare romanisation
in `KIND_RANK`, so it wins as a fallback when both exist, and the next person
reading the data does not conclude the source was lying when it was not.

The fold is used **only** to pick between the two fallback labels, never to decide
whether something is a fallback. A Latin-script language dropping a diacritic is
usually writing its own correct name, and demoting Turkish "İstanbul" for matching
English "Istanbul" would be this same error pointing the other way.

### And a path bug the test found

`PLACES_OUT` as an absolute path produced `join(ROOT, "/tmp/…")` → `<root>/tmp/…`,
so `history --append` read a file that was never there and appended nothing,
silently. Both `diff` and `history` resolve against ROOT now, which returns an
absolute argument unchanged.

---

## Still not done, and it is not a task

**Cities are 17–59% translated** for the languages that need translating, and that
is close to the ceiling of open data. Transliteration is the only thing left that
could raise it for non-Latin scripts, and it is a research problem rather than a
feature. It stays on the list as a known limit, not as work.

---

## The rule, again

The last record ended on it and this one earns it four more times:

> Every failure here is one question with more than one answer in the system.

The registry manifest in three places. The picker deciding which languages an
application offers. `@orpc/client` resolving to a different version than the eight
packages it shares types with. A client compiled by our tsconfig and never by a
consumer's.

The fix is never a better answer. It is one place that owns the question.
