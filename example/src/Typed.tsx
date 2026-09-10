/**
 * The same picker, driven by the typed client and TanStack Query.
 *
 * `App.tsx` is deliberately the other extreme: a hand-rolled `fetch` client, to
 * prove the API is usable without any of our packages. Both need to be true, and
 * only one of them is proof of the other.
 *
 * This is the shape the stack this component targets actually uses — React 19,
 * oRPC, TanStack Query — and it exercises three things `App.tsx` cannot:
 *
 *   the **typed client**, so a contract change is a compile error here
 *   the **RPC transport**, with batching, dedupe and Retry-After from the link plugins
 *   the picker's **data props**, which is the thing that lets a caller own fetching
 *
 * ## Why the picker does not depend on TanStack Query itself
 *
 * It would be less code. It would also mean every installer needs a
 * `QueryClientProvider` above the component or gets a runtime throw — and the
 * registry item is the one artefact here that lands in a stranger's project with
 * no way for us to check what is around it. So the component keeps working with
 * nothing, and this file shows what it looks like when you have something.
 *
 * `countries`, `subdivisions` and `cities` are passed in, so the component does
 * no fetching at all. The debounce stays where it was, because a consumer that
 * has to re-implement it to use their own data layer will not.
 */

import { useState } from "react"
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query"
import { createTanstackQueryUtils } from "@orpc/tanstack-query"
import { createPlacesClient } from "shadcn-places/client"
import { PlacesPicker, type PlacesValue, type Place } from "@/components/places-picker"

/**
 * One client, one set of query utils, both at module scope.
 *
 * `createPlacesClient` installs the batch, dedupe and Retry-After link plugins,
 * and all three are per-link state — built inside a component they would be
 * rebuilt on every render and would batch and dedupe nothing.
 */
const places = createPlacesClient({ url: "https://shadcn-places.gedw99.workers.dev" })
const orpc = createTanstackQueryUtils(places)

/**
 * Reference data, cached hard.
 *
 * The list of countries changes when a country does. Refetching it on window
 * focus is a request that cannot return anything new, and the whole reason this
 * service precomputes coverage is that requests it cannot avoid should be the
 * only ones it makes.
 */
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60 * 60 * 1000, refetchOnWindowFocus: false } },
})

function Picker() {
  const [locale, setLocale] = useState("ja")
  const [value, setValue] = useState<PlacesValue>({})
  const [q, setQ] = useState("")

  const locales = useQuery(orpc.locales.list.queryOptions({ input: { min: 40, tier: "country", by: "readers" } }))
  const countries = useQuery(orpc.countries.list.queryOptions({ input: { locale } }))

  const subdivisions = useQuery(
    orpc.subdivisions.list.queryOptions({
      input: { country: value.country ?? "", locale },
      // The cascade, expressed as a condition rather than as a guard inside the
      // component. Without a country there is no query to make — and the contract
      // makes that unrepresentable for a reason: an unscoped city search reads
      // every row in the table.
      enabled: Boolean(value.country),
    }),
  )

  const cities = useQuery(
    orpc.cities.search.queryOptions({
      input: { country: value.country ?? "", subdivision: value.subdivision, q, locale, limit: 20 },
      enabled: Boolean(value.country) && q.length > 0,
    }),
  )

  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="mb-2 text-xl font-semibold">shadcn-places · typed client + TanStack Query</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        The component fetches nothing here. Every row comes from a query the page owns.
      </p>
      <PlacesPicker
        locale={locale}
        onLocaleChange={setLocale}
        // The service holds 898 languages. A real application passes the ones it
        // has actually translated; this one passes what the service recommends,
        // because it is a demonstration and has nothing of its own to declare.
        locales={locales.data?.locales}
        countries={countries.data?.places as Place[] | undefined}
        subdivisions={subdivisions.data?.places as Place[] | undefined}
        cities={cities.data?.places as Place[] | undefined}
        onSearch={setQ}
        busy={{
          locales: locales.isLoading,
          countries: countries.isLoading,
          subdivisions: subdivisions.isFetching,
          cities: cities.isFetching,
        }}
        value={value}
        onChange={setValue}
        markUntranslated
      />
      <pre className="mt-6 text-xs opacity-60">{JSON.stringify(value, null, 2)}</pre>
    </main>
  )
}

export default function Typed() {
  return (
    <QueryClientProvider client={queryClient}>
      <Picker />
    </QueryClientProvider>
  )
}
