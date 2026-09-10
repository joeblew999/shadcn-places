# Three things this project told people to use that had never worked

Status: 2026-09-10. All three fixed, all three now tested.

Worth its own document because the pattern matters more than the bugs. Each was
discovered by somebody *trying* the thing, never by a test, and in each case the
repository's own checks were green throughout — because they verified the wrong
side of a boundary.

## What was broken

**The registry item.** `shadcn add https://…/r/places-picker.json` fetched the
item, installed `button`, `command`, `dialog` and `popover`, and silently skipped
the component. Exit code 0, "✔ Created 4 files". `registry.json` names files by
*path*, which means something in this repository and nothing to somebody else's
installer — the served item has to carry the file **content**.

**The typed client.** `import { createPlacesClient } from "shadcn-places/client"`
was in the README quick-start. There was no `src/client.ts` and no `exports`
field.

**The OpenAPI document.** The README said one existed. `/openapi.json` fell
through to the service's root document and answered **200** with something that
is not a spec — so a code generator pointed at it would get nothing, from a URL
that looked healthy.

## Why every check passed

| The check | What it asserted | What it should have asserted |
| --- | --- | --- |
| registry | the file path exists **in this repo** | the **served item** carries the content |
| licences | the source id appears in the README | the declared **credit wording** appears |
| service | *(none — no test made a request)* | the deployed endpoints answer |

And two tests that could not fail at all:

- `it.skipIf(cond)` reads `cond` at **collection** time. Probing the server in
  `beforeAll` meant every test in the file skipped, and the suite reported
  "39 passed | 16 skipped" — green, and testing nothing.
- The licence check matched a fragment of a source id, so crediting
  "© OpenStreetMap contributors" — the exact wording ODbL requires — failed,
  while the string "osm" anywhere would have passed.

**A test that cannot fail is worse than no test, because it is counted.**

## What now exists

- **`tests/api/service.test.ts`** — 20 tests that make real requests, runnable
  against the dev server or the deployment. Both need to be true and they have
  disagreed: remote D1 refuses `BEGIN TRANSACTION` that local D1 accepts.
- **[`example/`](../example/)** — a bare consumer project. `bun run install-picker
  && bun run check` installs from the deployed registry URL and typechecks
  against a consumer's own tsconfig, `@/` alias and shadcn components. The test
  asserts `places-picker.tsx` exists afterwards, because `shadcn add` reports
  success for having written the *dependencies*.
- **`places registry`** — generates the served items with the source embedded,
  and `sync` rebuilds them so they cannot go stale against the component.

## The rule this leaves

**A registry item is the one artefact a project publishes and never compiles.**
The same is true of a documented import path and a spec URL: they are used only
from outside, so they can only be tested from outside. Anything the README tells
a stranger to do should be done, by a test, against the deployed thing.
