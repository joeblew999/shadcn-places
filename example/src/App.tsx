/**
 * The smallest thing that proves the component works in somebody else's project.
 *
 * Not a demo — the demo is `public/index.html`, which is plain HTML and shares no
 * code with the component. This is the other half: the React component, installed
 * from the registry the way a stranger installs it, compiled against a consumer's
 * own shadcn components and their own `@/` alias.
 *
 * That distinction cost a day. `shadcn add` had been silently writing four
 * dependencies and skipping the component itself, and nothing noticed because the
 * demo worked, the API worked, and the repository's own checks verified a file
 * path that existed here rather than the item served over the wire.
 *
 * So this compiles, and `bun run check` in this directory is the proof.
 */

import { useState } from "react"
import { PlacesPicker, type PlacesValue } from "@/components/places-picker"

/**
 * A constant, not `import.meta.env`.
 *
 * This project has no bundler on purpose — adding Vite to type one environment
 * variable would mean the thing under test compiles against a build tool rather
 * than against a consumer's tsconfig, which is the whole point of it being bare.
 */
const BASE = "https://shadcn-places.gedw99.workers.dev"

/**
 * A client, written the way a consumer writes one.
 *
 * Deliberately hand-rolled against the HTTP endpoints rather than importing a
 * generated client: it shows that the API is usable without our packages, and it
 * is the shape somebody reaches for first.
 */
const client = {
  countries: {
    list: (i: { locale: string }) =>
      fetch(`${BASE}/api/countries?locale=${i.locale}`).then((r) => r.json()),
  },
  subdivisions: {
    list: (i: { country: string; locale: string }) =>
      fetch(`${BASE}/api/subdivisions?country=${i.country}&locale=${i.locale}`).then((r) => r.json()),
  },
  cities: {
    search: (i: { country: string; subdivision?: string; q: string; locale: string }) =>
      fetch(
        `${BASE}/api/cities?country=${i.country}&q=${encodeURIComponent(i.q)}&locale=${i.locale}` +
          (i.subdivision ? `&subdivision=${encodeURIComponent(i.subdivision)}` : ""),
      ).then((r) => r.json()),
  },
}

export default function App() {
  const [value, setValue] = useState<PlacesValue>({})
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="mb-6 text-xl font-semibold">shadcn-places · installed component</h1>
      <PlacesPicker
        client={client}
        locale="ja"
        value={value}
        onChange={setValue}
        // On for a Japanese reader: a Latin fallback is unreadable rather than
        // merely unidiomatic, and knowing which names are missing is the point.
        markUntranslated
      />
      <pre className="mt-6 text-xs opacity-60">{JSON.stringify(value, null, 2)}</pre>
    </main>
  )
}
