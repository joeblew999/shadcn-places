/**
 * The typed client, which the README has promised since the day it was written.
 *
 * It did not exist. `import { createPlacesClient } from "shadcn-places/client"`
 * was in the quick-start, and there was no `src/client.ts` and no `exports` field
 * — the same failure as the registry item, one layer up: documented, never built,
 * never tested, and nothing red anywhere.
 *
 * ## Why one function and not a package of them
 *
 * oRPC separates the contract from the transport, so a client is the contract
 * plus a `fetch`. That is the entire abstraction, and it is what makes the
 * service usable three ways without three clients:
 *
 *   a Worker on the same account   fetch: env.PLACES.fetch   — no public hop
 *   anyone else's runtime          fetch: undefined          — the public URL
 *   a test, or a local dev server  url: "http://localhost:8787"
 *
 * The types come from the contract, so a change to the contract is a compile
 * error in every consumer rather than a runtime surprise.
 */

import { createORPCClient } from "@orpc/client"
import { RPCLink } from "@orpc/client/fetch"
import { BatchLinkPlugin, DedupeRequestsPlugin, RetryAfterPlugin } from "@orpc/client/plugins"
import type { ContractRouterClient } from "@orpc/contract"
/**
 * Extensionless, unlike every other import in this repository.
 *
 * This file is a *published entry point* — `shadcn-places/client` — and the rest
 * of them are not. A `.ts` import extension requires `allowImportingTsExtensions`
 * in the tsconfig doing the compiling, which is ours and is not a consumer's. So
 * this line compiled here and failed in every project that installed the package:
 *
 *   error TS5097: An import path can only end with a '.ts' extension when
 *   'allowImportingTsExtensions' is enabled
 *
 * Found the day `example/` first imported the typed client rather than
 * hand-rolling one, which is the fourth thing this project has documented,
 * published and never once executed the way a stranger would. The others were the
 * registry item, this same client's existence, and the OpenAPI document.
 *
 * tests/repo/package.test.ts now walks every export in the map and fails on a
 * `.ts` extension anywhere it can reach.
 */
import { contract } from "./api/contract"

export type PlacesClient = ContractRouterClient<typeof contract>

export interface PlacesClientOptions {
  /**
   * Where the service is. Defaults to the public deployment.
   *
   * Pass a local URL in tests, or leave it and pass `fetch` instead when calling
   * a service binding — the URL is then only used to build a request object the
   * binding never sends over the network.
   */
  url?: string
  /**
   * A `fetch` to use instead of the global one.
   *
   * The reason a service binding works at all: `env.PLACES.fetch` *is* a fetch,
   * so the same typed client speaks to a Worker on the same account with no
   * public hop and no egress, and to a URL for everybody else.
   */
  fetch?: (request: Request) => Promise<Response>
  headers?: Record<string, string>
}

const DEFAULT_URL = "https://shadcn-places.gedw99.workers.dev"

export function createPlacesClient(options: PlacesClientOptions = {}): PlacesClient {
  const base = (options.url ?? DEFAULT_URL).replace(/\/$/, "")
  const link = new RPCLink({
    /**
     * Origin and path, separately — which is a 2.0 change and a real improvement.
     *
     * 1.x took one `url` and split it internally. 2.0 asks for the origin (used
     * for CORS and for building the request) and the prefix (which must match the
     * handler's) as two values, so a mismatch between them is a type error rather
     * than a 404 at runtime. The handler mounts at `/rpc`, so this is `/rpc`.
     */
    origin: base,
    url: "/rpc",
    headers: options.headers,
    /**
     * The custom fetch, adapted to 2.0's signature.
     *
     * 1.x handed the override a `Request`; 2.0 hands it `(url, init)` — the same
     * pair it would pass to `globalThis.fetch`. A service binding's `.fetch` takes
     * a `Request`, so the adapter builds one. This is the *only* line standing
     * between this client and a Worker-to-Worker call with no public hop, and the
     * test that asserts the custom fetch is actually called exists because
     * a silently-ignored fetch would look identical from the outside.
     */
    fetch: options.fetch
      ? (url, init) => options.fetch!(new Request(url, init))
      : undefined,
    plugins: [
      /**
       * The other half of the batching, without which the server's half does
       * nothing.
       *
       * `BatchHandlerPlugin` went on the handler and no client batched, so the
       * feature was inert — a plugin that costs nothing and achieves nothing.
       * The picker's cascade is three sequential calls (countries, then that
       * country's subdivisions, then a search), and on a slow connection three
       * round trips is what the user feels.
       */
      new BatchLinkPlugin({ groups: [{ condition: () => true, context: {} }] }),

      /**
       * Identical in-flight calls collapse into one.
       *
       * A picker mounted twice on a page, or React asking for the country list
       * from two components, currently makes two requests for the same 257 rows.
       * Reference data is the ideal case for this: the answer cannot change
       * between two calls a millisecond apart.
       */
      new DedupeRequestsPlugin({ groups: [{ condition: () => true, context: {} }] }),

      /**
       * Honour `Retry-After` rather than hammering.
       *
       * This service leans on Wikidata and Overpass, both of which rate-limit, and
       * it will eventually rate-limit its own callers. A client that respects the
       * header is the difference between backing off and making it worse — and
       * having spent today on the receiving end of 429s, it would be strange to
       * ship a client that ignores them.
       */
      new RetryAfterPlugin(),
    ],
  })
  return createORPCClient(link)
}
