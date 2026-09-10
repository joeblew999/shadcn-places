/**
 * Country → subdivision → city, in the reader's language.
 *
 * The cascade is not a UX preference. D1 bills rows scanned, so a city search that
 * is not filtered by a parent reads every row in the table on every keystroke —
 * which is a bill, and on a free plan an outage. Filtering by country and matching
 * a prefix reads a handful. The interface people want and the query the database
 * can afford turn out to be the same one, which is not always how it goes.
 *
 * Three controls rather than one, and the third one searches because thirty-four
 * thousand cities is where search earns its place. Two hundred and eighty
 * countries do not need it, so the first control is a plain select — search added
 * everywhere is search nobody reads.
 *
 * ## Two things this component refuses to decide
 *
 * **Which languages you offer.** `locales` is a prop. The service holds 898 and
 * an application has some smaller number it has actually translated; a picker
 * offering the first when the app supports the second is a picker that shows
 * people a language and then fails to speak it. Omitted, it asks the service —
 * which is the right default for a demo and the wrong one for a product, and the
 * distinction belongs to the caller.
 *
 * **Where the rows come from.** Pass `client` and it fetches. Pass `countries`,
 * `subdivisions` and `cities` and it renders what you give it, which is how it
 * works under TanStack Query, SWR, a server component, or a test with fixtures.
 * The built-in fetching is a convenience, not the contract.
 */

"use client"

import * as React from "react"
import { Check, ChevronsUpDown, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

export interface PlacesClient {
  countries: { list: (i: { locale: string }) => Promise<{ places: Place[] }> }
  subdivisions: { list: (i: { country: string; locale: string }) => Promise<{ places: Place[] }> }
  cities: {
    search: (i: { country: string; subdivision?: string; q: string; locale: string }) => Promise<{ places: Place[] }>
  }
  /**
   * Only needed when the language control is shown and `locales` is not supplied.
   *
   * Optional so that a caller who passes its own list does not have to implement
   * an endpoint it will never call.
   */
  locales?: {
    list: (i: { min?: number; tier?: string; by?: string }) => Promise<{ locales: LocaleOption[] }>
  }
}

export interface Place {
  id: string
  name: string
  /** `romanised` means nobody has translated this into the reader's language yet. */
  kind: "translated" | "native" | "romanised" | "transliterated"
  countryCode: string | null
}

/** A language this picker may be shown in. `/api/locales` returns exactly this shape. */
export interface LocaleOption {
  /** BCP-47. */
  code: string
  /** The language in its own language — the only name that helps somebody who cannot read the current interface. */
  endonym: string
  /** Literate readers. 0 means CLDR has no estimate, not that nobody reads it. */
  readers?: number
  /** Percent coverage per tier, if the source provided it. */
  coverage?: Record<string, number>
}

export interface PlacesValue {
  country?: string
  subdivision?: string
  city?: string
}

export interface PlacesPickerProps {
  /**
   * How to fetch. Omit only if you are supplying every tier yourself.
   *
   * `createPlacesClient()` from `shadcn-places/client` returns one, and so does
   * any object with these three methods — a service binding, a mock, or fifteen
   * lines of `fetch`.
   */
  client?: PlacesClient
  /** BCP-47. Whatever your app's current locale is — the service holds them all. */
  locale?: string
  value?: PlacesValue
  onChange?: (value: PlacesValue) => void
  labels?: {
    country?: string
    subdivision?: string
    city?: string
    search?: string
    empty?: string
    language?: string
  }
  className?: string
  /**
   * Show a marker on names that are romanised rather than translated.
   *
   * Off by default: for a Latin-script reader the romanisation *is* the name, and
   * flagging it would be noise. Worth turning on for Thai, Japanese, Korean,
   * Russian, Arabic and the rest, where a Latin string is not a lesser
   * translation but an unreadable one — and where a reader benefits from knowing
   * the data is missing rather than assuming the place is spelled that way.
   */
  markUntranslated?: boolean

  // ---- the language control ------------------------------------------------

  /**
   * Called when the reader picks a language. Providing it is what shows the control.
   *
   * Without it there is no language control at all, because a picker that lets
   * somebody change a setting nothing listens to is worse than one that does not
   * offer it.
   */
  onLocaleChange?: (code: string) => void
  /**
   * The languages to offer. Omit to ask the service for the ones worth offering.
   *
   * This is the prop that keeps the component honest. An application that has
   * translated its interface into twenty-seven languages should pass those
   * twenty-seven; the service holding 898 is not a reason to list 898.
   */
  locales?: LocaleOption[]
  /**
   * Minimum coverage, when the list is fetched rather than given.
   *
   * Below about 40 a reader sees more fallbacks than names, and offering the
   * language promises more than is there. Ignored entirely when `locales` is set.
   */
  localeMin?: number
  /** Which tier `localeMin` applies to. A picker used for cities should ask about cities. */
  localeTier?: "country" | "subdivision" | "city"

  // ---- bring your own data layer -------------------------------------------

  /**
   * Supply the rows instead of letting the component fetch them.
   *
   * Any tier passed here is used as given and its fetch is skipped, so this
   * works one tier at a time. With TanStack Query the whole set comes from
   * `useQuery`, and this component becomes what it should have been from the
   * start: something that renders places rather than something that knows how to
   * get them.
   */
  countries?: Place[]
  subdivisions?: Place[]
  cities?: Place[]
  /**
   * Called with the city query as it is typed, already debounced.
   *
   * Required when `cities` is controlled — it is the only way the caller learns
   * what to fetch. Ignored otherwise, because the built-in search covers it.
   */
  onSearch?: (q: string) => void
  /** Spinner control when the data is coming from somewhere this component cannot see. */
  busy?: { countries?: boolean; subdivisions?: boolean; cities?: boolean; locales?: boolean }
  /** Milliseconds to wait after a keystroke before searching. */
  searchDelay?: number
}

/** What a combobox row needs. `Place` and the language rows both satisfy it. */
interface Option {
  id: string
  name: string
  /** Rendered muted after the name — a language code, or nothing. */
  hint?: string
  kind?: string
}

/** One combobox. Extracted because four of them differ only in where the rows come from. */
function Picker({
  label, placeholder, empty, options, value, onSelect, disabled, loading, searchable, onSearch, markUntranslated,
}: {
  label: string
  placeholder: string
  empty: string
  options: Option[]
  value?: string
  onSelect: (id: string | undefined) => void
  disabled?: boolean
  loading?: boolean
  searchable?: boolean
  onSearch?: (q: string) => void
  markUntranslated?: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const selected = options.find((o) => o.id === value)
  return (
    <div className="grid gap-1.5">
      <span className="text-sm font-medium text-muted-foreground">{label}</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className="justify-between font-normal"
          >
            <span className={cn(!selected && "text-muted-foreground")}>{selected?.name ?? placeholder}</span>
            {loading ? (
              <Loader2 className="ml-2 size-4 shrink-0 animate-spin opacity-50" />
            ) : (
              <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <Command shouldFilter={!searchable}>
            <CommandInput placeholder={placeholder} onValueChange={searchable ? onSearch : undefined} />
            <CommandList>
              <CommandEmpty>{empty}</CommandEmpty>
              <CommandGroup>
                {options.map((o) => (
                  <CommandItem
                    key={o.id}
                    // A searchable list is filtered by the server, so the value must
                    // be the id or Command re-filters what came back. A local list
                    // is filtered by Command, so it must be the visible text — and
                    // the hint goes in too, so typing "ja" finds 日本語.
                    value={searchable ? o.id : `${o.name} ${o.hint ?? ""}`}
                    onSelect={() => {
                      onSelect(o.id === value ? undefined : o.id)
                      setOpen(false)
                    }}
                  >
                    <Check className={cn("mr-2 size-4", o.id === value ? "opacity-100" : "opacity-0")} />
                    <span>{o.name}</span>
                    {o.hint && <span className="ml-2 text-xs text-muted-foreground">{o.hint}</span>}
                    {markUntranslated && o.kind === "romanised" && (
                      <span className="ml-auto text-xs text-muted-foreground" title="not translated into this language">
                        ·
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}

export function PlacesPicker({
  client,
  locale = "en",
  value,
  onChange,
  labels,
  className,
  markUntranslated,
  onLocaleChange,
  locales: givenLocales,
  localeMin = 40,
  localeTier = "country",
  countries: givenCountries,
  subdivisions: givenSubdivisions,
  cities: givenCities,
  onSearch,
  busy,
  searchDelay = 200,
}: PlacesPickerProps) {
  const [fetchedCountries, setCountries] = React.useState<Place[]>([])
  const [fetchedSubdivisions, setSubdivisions] = React.useState<Place[]>([])
  const [fetchedCities, setCities] = React.useState<Place[]>([])
  const [fetchedLocales, setLocales] = React.useState<LocaleOption[]>([])
  const [loading, setLoading] = React.useState<"countries" | "subdivisions" | "cities" | null>(null)
  const selection = value ?? {}

  // A tier that was passed in is never fetched. Checked by identity rather than
  // by emptiness: `[]` is a legitimate answer meaning "nothing matched", and
  // treating it as "not supplied" would make the component fetch over the top of
  // a caller's deliberate empty result.
  const controlled = {
    countries: givenCountries !== undefined,
    subdivisions: givenSubdivisions !== undefined,
    cities: givenCities !== undefined,
    locales: givenLocales !== undefined,
  }

  const set = (next: PlacesValue) => onChange?.(next)

  /**
   * The languages, when the caller wanted the control but not the list.
   *
   * Only fetched if the control is shown at all — an application passing its own
   * `locales`, or not offering a language control, must never pay for this call.
   */
  React.useEffect(() => {
    if (controlled.locales || !onLocaleChange || !client?.locales) return
    let live = true
    client.locales.list({ min: localeMin, tier: localeTier, by: "readers" }).then((r) => {
      if (live) setLocales(r.locales)
    })
    return () => { live = false }
  }, [client, controlled.locales, onLocaleChange, localeMin, localeTier])

  React.useEffect(() => {
    if (controlled.countries || !client) return
    let live = true
    setLoading("countries")
    client.countries.list({ locale }).then((r) => {
      if (live) { setCountries(r.places); setLoading(null) }
    })
    return () => { live = false }
  }, [client, controlled.countries, locale])

  // Changing the country invalidates everything below it. Clearing the child
  // selections is the point: a city from the previous country would otherwise
  // stay selected and look deliberate.
  React.useEffect(() => {
    if (controlled.subdivisions || !client) return
    if (!selection.country) { setSubdivisions([]); setCities([]); return }
    let live = true
    setLoading("subdivisions")
    client.subdivisions.list({ country: selection.country, locale }).then((r) => {
      if (live) { setSubdivisions(r.places); setLoading(null) }
    })
    return () => { live = false }
  }, [client, controlled.subdivisions, locale, selection.country])

  /**
   * Debounced, because each keystroke is a database query somebody pays for.
   *
   * 200ms is short enough to feel immediate and long enough that typing "bangkok"
   * costs one query rather than seven. The debounce runs even when the caller owns
   * the data — a TanStack consumer wants the same protection and should not have
   * to re-implement it to get it.
   */
  const searchCities = React.useMemo(() => {
    let timer: ReturnType<typeof setTimeout>
    return (q: string) => {
      clearTimeout(timer)
      if (!selection.country) return
      if (q.length < 1) {
        onSearch?.("")
        if (!controlled.cities) setCities([])
        return
      }
      timer = setTimeout(async () => {
        onSearch?.(q)
        if (controlled.cities || !client) return
        setLoading("cities")
        const r = await client.cities.search({
          country: selection.country!,
          subdivision: selection.subdivision,
          q,
          locale,
        })
        setCities(r.places)
        setLoading(null)
      }, searchDelay)
    }
  }, [client, controlled.cities, locale, onSearch, searchDelay, selection.country, selection.subdivision])

  const countries = givenCountries ?? fetchedCountries
  const subdivisions = givenSubdivisions ?? fetchedSubdivisions
  const cities = givenCities ?? fetchedCities
  const locales = givenLocales ?? fetchedLocales

  const spinning = (tier: "countries" | "subdivisions" | "cities") =>
    busy?.[tier] ?? loading === tier

  const t = {
    country: labels?.country ?? "Country",
    subdivision: labels?.subdivision ?? "State or province",
    city: labels?.city ?? "City",
    search: labels?.search ?? "Type to search",
    empty: labels?.empty ?? "Nothing found",
    language: labels?.language ?? "Language",
  }

  /**
   * Languages named in their own language, with the tag beside them.
   *
   * The endonym is what a reader looking for their language actually scans for —
   * nobody hunting for Japanese reads "ญี่ปุ่น". The code is kept visible because
   * two languages can share an endonym in a way that is obvious to a native
   * speaker and baffling to whoever is configuring the app.
   */
  const localeOptions: Option[] = locales.map((l) => ({ id: l.code, name: l.endonym, hint: l.code }))

  return (
    <div
      className={cn(
        "grid gap-4",
        onLocaleChange ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-3",
        className,
      )}
    >
      {onLocaleChange && (
        <Picker
          label={t.language}
          placeholder={t.language}
          empty={t.empty}
          options={localeOptions}
          value={locales.some((l) => l.code === locale) ? locale : undefined}
          loading={busy?.locales}
          // Never cleared to undefined: there is no such thing as "no language",
          // and a picker that can be emptied into one is a bug waiting for a
          // reader who cannot read what is left.
          onSelect={(code) => onLocaleChange(code ?? locale)}
        />
      )}
      <Picker
        label={t.country}
        placeholder={t.country}
        empty={t.empty}
        options={countries}
        value={selection.country ? `country:${selection.country}` : undefined}
        loading={spinning("countries")}
        markUntranslated={markUntranslated}
        onSelect={(id) => set({ country: id?.replace("country:", "") })}
      />
      <Picker
        label={t.subdivision}
        placeholder={selection.country ? t.subdivision : "—"}
        empty={t.empty}
        options={subdivisions}
        value={selection.subdivision}
        disabled={!selection.country}
        loading={spinning("subdivisions")}
        markUntranslated={markUntranslated}
        onSelect={(id) => set({ ...selection, subdivision: id, city: undefined })}
      />
      <Picker
        label={t.city}
        placeholder={selection.country ? t.search : "—"}
        empty={t.empty}
        options={cities}
        value={selection.city}
        disabled={!selection.country}
        loading={spinning("cities")}
        searchable
        onSearch={searchCities}
        markUntranslated={markUntranslated}
        onSelect={(id) => set({ ...selection, city: id })}
      />
    </div>
  )
}
