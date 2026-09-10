# One answer per question

Two days of work landed in one afternoon and both halves turned out to be the
same mistake in different clothes: **a question being asked in more than one
place, and the places disagreeing.**

---

## Part one: oRPC 2.0, and a file nothing compiled

### Why the major version

`@orpc/openapi` 1.15 could not generate a specification for *any* route with a
dynamic path parameter. Not for a particular schema shape — for all of them.
Routes served perfectly at runtime and the generator threw, so the choice was a
readable URL or a machine-readable API, and this API spent an afternoon as flat
query strings: `/api/subdivisions?country=TH`.

2.0 fixes it. Verified before migrating anything:

```
2.0 dynamic path param: WORKS → /c/{country}/s
```

All eight procedures now sit at REST paths and the spec generates for every one.

### What the migration found

Migrating meant compiling `src/index.ts`, which is how it emerged that nothing
ever had. `tsconfig.json`'s `include` was:

```json
["src/api", "src/db", "scripts", "tests", "*.ts"]
```

The Worker — the module that serves every request — was outside the program.
`bun run typecheck` had been passing over a file written against a different
major version of oRPC. `src/client.ts` was checked only by accident, because a
test imports it.

Three real defects were sitting in it, none of which any check could see:

| | |
| --- | --- |
| duplicate `openapi` key in the root document | the second silently won, the first was never served |
| forty lines of unreachable route handlers | calling `openapiSpec`, which does not exist |
| `notice: "/api/attribution/get"` | not a URL this service has |

`@orpc/client` was also a phantom dependency: imported by `src/client.ts`, absent
from `package.json`, resolving only because eight other `@orpc/*` packages pull it
in and bun hoists it.

**The include is now `src` minus `src/web`**, and `Env` comes from `wrangler
types` rather than four hand-written lines that could disagree with the bindings.
An allowlist of directories silently excludes every file added after it was
written; a denylist of the one directory that genuinely cannot compile here fails
loudly instead.

### The 2.0 API changes that mattered

- `RPCLink` takes `origin` and `url` (the prefix) separately, so a mismatch
  between them is a type error rather than a 404.
- A custom `fetch` receives `(url, init)` rather than a `Request`. That is the
  single line service bindings depend on, and `tests/api/service.test.ts` asserts
  the custom fetch is actually called — a silently-ignored one looks identical
  from outside.
- `OpenAPIReferenceHandlerPlugin` takes a *document* rather than converters and
  generate-options, so the spec is now a value this module owns and three call
  sites read one object.
- `generate()` nests `info` and `servers` under `base`.
- **The Zod-specific coercion plugin is gone.** The generic
  `SmartCoercionHandlerPlugin` takes `converters` — and with none it silently
  coerces nothing, which is exactly the 1.x failure where the wrong assumption
  broke production for two minutes. Verified against a running server before
  deploying: `limit=3` returns 3.

### Moving the paths broke the published ones

Restoring REST 404'd all four flat URLs published that morning, while
`contract.ts` carried a comment saying they kept working. A comment is not a
compatibility guarantee.

`LEGACY_PATHS` in `src/index.ts` rewrites them and marks the response deprecated
per RFC 8594. **Rewritten rather than redirected**: a 308 is tidier and breaks
`curl` without `-L`, which is exactly how somebody would try this from a
terminal. The unscoped city search stays a 404 — no country in the query means no
path to rewrite to, so the rewrite cannot become the hole the scoping closed.

---

## Part two: the script classification, asked in three runtimes

### The fifth measurement error

`/api/matrix` ranked gaps using `real` — names excluding romanised fallbacks —
for every language. Measured after the OSM pass:

```
es   latin=true   named  51%   translated  14%
pt   latin=true   named  42%   translated  10%
fr   latin=true   named  59%   translated  18%
zh   latin=false  named  52%   translated  52%
hi   latin=false  named  17%   translated  17%
```

The 37-point gap for Spanish is names identical to the English pivot — and for
Spanish those are usually *correct*. São Paulo is São Paulo in Spanish.

So the ranking put Spanish second in the world with 59,838 cities "missing", two
thirds of which are not missing. That is not cosmetic: `gapLocales()` in
`refresh.ts` reads this ranking to choose which languages get the weekly SPARQL
budget. A scarce, rate-limited resource was being aimed at languages whose
fallback already reads correctly.

`/api/coverage/{locale}` had returned `latinScript` from the beginning, telling
callers which of the two numbers to read. The matrix was not taking its own
advice.

### The list was missing thirty-nine

`NON_LATIN_SCRIPT` was fifty language codes typed by hand. Against the loaded
database it was missing 39 locales with more than 150 names each — Egyptian
Arabic with 12,681, Tatar with 8,177, Wu, Cantonese, Chechen, Bashkir, Odia — all
classified as Latin because nobody had thought of them. It also had Kurdish wrong
the other way: `ku` is Kurmanji and is written in Latin; Sorani is `ckb`.

The second consequence is worse than the first. `resolve()` in `merge.ts` gates
its demotion of a Latin value to `romanised` on this very set:

```ts
if (!isLatinLocale(name.locale) && isLatinScript(name.value)) return "romanised"
```

**So for thirty-nine languages the honesty check this project is organised around
was not running at all.** The rebuild found 630 of them — "Medea" filed as a
Tatar translation, "Kukës" as Cantonese — now correctly marked as fallbacks.

### Why CLDR is the right source and the wrong mechanism

`Intl.Locale#maximize` resolves a tag to its likely script from CLDR's own data,
with no list to maintain. It agrees with the observed script of our names 178
times out of 187.

But it **disagrees with itself across runtimes.** Across the 710 locales here,
Bun's ICU and Node's ICU differ on 30:

```
ur:   bun=Aran  node=Arab      pnb:  bun=null  node=Arab
ber:  bun=Tfng  node=null      bxr:  bun=null  node=Cyrl
```

workerd is a third ICU. And three parts of this system were each asking
separately: the merge (Bun) decided what counts as a translation, the tests
(Node) asserted on the result, the Worker (workerd) reported it as coverage.

The user asked the sharpening question: *we plan to run ETL and runtime on
workerd both locally and on CF — what does that say about this?*

It removes one axis and not the other. Local `wrangler dev` and Cloudflare's edge
run different workerd builds, and `compatibility_date` pins behaviour flags, not
the ICU data version. **But the axis that never goes away is time.** The merge
decides at ETL time; the Worker reports weeks later on an upgraded runtime. Same
code, same binary family, different answer.

### So it is decided once and stored

`coverage.latin` — 1 if a Latin string reads correctly for this locale, 0 if not.
Computed by the ETL from the names themselves where there are 150 or more of
them, falling back to CLDR below that, and written into the table every consumer
already reads.

The data is unambiguous where it exists. Raw share of Latin-script values,
*including* romanised fallbacks:

```
th 0%   ja 0%   zh 0%   ko 0%   ru 0%   hi 0%   ar 0%   he 0%   el 0%
```

There is nothing a lookup table can add to that.

`280 of 898 locales need a non-Latin script to read`, and every one of the merge,
the matrix, the language list and the refresh now reads that same column.

### The test reads the artefact, not a re-run

The obvious test calls the classifier and compares — and would prove something
about Node and nothing about the ETL or the Worker. `tests/repo/data.test.ts`
parses the `UPDATE coverage SET latin = 0` statements the ETL actually emitted
and checks them against the names it emitted them from.

---

## What the ranking says now

```
zh   city  52%  missing 33252  readers 1223M
hi   city  17%  missing 57679  readers  365M
es   city  51%  missing 34387  readers  478M
ar   city  36%  missing 44934  readers  291M
bn   city  17%  missing 58170  readers  167M
```

Hindi moved from third to second, Spanish fell to third with an honest 51%, and
French went from 18% to 59%.

## OSM, folded in

All 245 countries staged. 40,869 cities matched, **146,510 names OSM had and we
did not**, of which 118,333 survived the merge's precedence. No places lost.

---

## The rule both halves point at

Every failure here — the 76MB blob, the two-writer divergence between D1 and the
local build, the unchecked Worker, the script classification — is one question
with more than one answer in the system.

The fix is never a better answer. It is one place that owns the question.
