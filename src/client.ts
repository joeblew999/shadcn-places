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
import type { ContractRouterClient } from "@orpc/contract"
import { contract } from "./api/contract.ts"

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
    url: `${base}/rpc`,
    headers: options.headers,
    // oRPC's fetch adapter takes a custom fetch; a service binding is one.
    fetch: options.fetch ? (request) => options.fetch!(request) : undefined,
  })
  return createORPCClient(link)
}
