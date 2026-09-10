# One command, and using the platform properly

Status: 2026-09-10. Implemented.

## `places sync`

The cycle was eight steps typed by hand perhaps thirty times: pull, merge, diff,
load, apply locally, apply remotely, publish, check. **Every one of the day's
worst failures was a step-in-sequence error rather than a logic error** — a 76MB
blob committed because `.gitignore` came after the file was tracked, `data/` a
version behind because re-exporting is separate, twenty-five languages of labels
discarded because a pass ran before a pull.

A CLI that requires a person to remember an order has a bug in it.

The order is load-bearing:

| | why it is there |
| --- | --- |
| **pull** first | or the merge silently drops a week of scheduled work |
| **diff** before writing | a diff afterwards is a post-mortem |
| **load `--delta`** | a full rewrite is 81MB to change 64 rows |
| **local before remote** | remote D1 refuses things local D1 accepts |
| **publish last, never skipped** | `data/` is the ODbL obligation *and* the next diff's baseline |

It stops if the build loses places, parsing the diff's own output — so the number
that gates the run is the number the human was shown. Two numbers that could
disagree make the gate worthless.

## What the platform was already offering

Found by reading oRPC's Cloudflare adapter docs and its playground, after having
hand-rolled several of these:

| | replaces | why it matters |
| --- | --- | --- |
| `enable_request_signal` | nothing | the picker debounces and aborts; without it the Worker kept running D1 queries nobody awaited, and **D1 bills rows scanned** |
| `unhandled_rejection_after_microtask_checkpoint` | nothing | this service has had two failures that reported success |
| `CORSPlugin` | 15 lines of header copying | a preflight answered by the handler that knows the routes |
| `EvlogHandlerPlugin({ logAbort })` | nothing | the pair to the signal flag: records that a request *did* abort |
| `BatchHandlerPlugin` | nothing | the cascade is three sequential calls; a batching consumer pays one round trip |
| `OpenAPIReferencePlugin` | two hand-written routes | the spec cannot drift from the handler because it *is* the handler |
| `experimental_ZodSmartCoercionPlugin` | `z.coerce` on each field | fixes the class, not the instance |
| `CloudflareTracer` | nothing | **there was no observability at all** |

That last one is the biggest. Every failure this project has had was found by a
person watching a page — a 500 on every subdivision request, a 431 from Wikidata,
a spec generator throwing inside a route, `/api/matrix` taking 7.3 seconds for a
week. None appeared anywhere, because nothing was recording.

## Two things that cost real time

**`wrangler r2 object get` reads local simulated storage unless given `--remote`.**
The Workflow reported its writes as successful and the CLI said the key did not
exist, and both were telling the truth about different buckets. An hour, settled
only by probing the binding from *inside a request* — the one place that can see
what the Workflow sees.

**`@orpc/openapi` 1.15.0 cannot generate a specification for any route with a
dynamic path parameter.** Not for a particular schema shape: a required string, a
strict object, and oRPC's own `inputStructure: "detailed"` all fail with *"input
schema must be an object with all dynamic params as required"* while the Zod
converter demonstrably emits exactly that. Verified on the latest version against
both a contract and an implemented router. The routes served fine at runtime.

So `/countries/{country}/subdivisions` became `/subdivisions?country=BR`. A public
API with no machine-readable spec is one people integrate against by guessing, and
that trade is not close.

## A mistake worth not repeating

`SmartCoercionPlugin` is what the oRPC playground uses. It coerced nothing here. I
removed the working `z.coerce` on the assumption it would and **broke the deployed
service for two minutes**. The Zod-specific plugin does work — proven locally,
one field at a time, before anything was deployed.

The playground uses a different Zod entrypoint. Reasoning from somebody else's
working example is not the same as testing your own.
