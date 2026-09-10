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
}

export interface Place {
  id: string
  name: string
  /** `romanised` means nobody has translated this into the reader's language yet. */
  kind: "translated" | "native" | "romanised" | "transliterated"
  countryCode: string | null
}

export interface PlacesValue {
  country?: string
  subdivision?: string
  city?: string
}

export interface PlacesPickerProps {
  client: PlacesClient
  /** BCP-47. Whatever your app's current locale is — the service holds them all. */
  locale?: string
  value?: PlacesValue
  onChange?: (value: PlacesValue) => void
  labels?: { country?: string; subdivision?: string; city?: string; search?: string; empty?: string }
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
}

/** One combobox. Extracted because three of them differ only in where the rows come from. */
function Picker({
  label, placeholder, empty, options, value, onSelect, disabled, loading, searchable, onSearch, markUntranslated,
}: {
  label: string
  placeholder: string
  empty: string
  options: Place[]
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
                    value={searchable ? o.id : o.name}
                    onSelect={() => {
                      onSelect(o.id === value ? undefined : o.id)
                      setOpen(false)
                    }}
                  >
                    <Check className={cn("mr-2 size-4", o.id === value ? "opacity-100" : "opacity-0")} />
                    <span>{o.name}</span>
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
  client, locale = "en", value, onChange, labels, className, markUntranslated,
}: PlacesPickerProps) {
  const [countries, setCountries] = React.useState<Place[]>([])
  const [subdivisions, setSubdivisions] = React.useState<Place[]>([])
  const [cities, setCities] = React.useState<Place[]>([])
  const [loading, setLoading] = React.useState<"countries" | "subdivisions" | "cities" | null>("countries")
  const selection = value ?? {}

  const set = (next: PlacesValue) => onChange?.(next)

  React.useEffect(() => {
    let live = true
    setLoading("countries")
    client.countries.list({ locale }).then((r) => {
      if (live) { setCountries(r.places); setLoading(null) }
    })
    return () => { live = false }
  }, [client, locale])

  // Changing the country invalidates everything below it. Clearing the child
  // selections is the point: a city from the previous country would otherwise
  // stay selected and look deliberate.
  React.useEffect(() => {
    if (!selection.country) { setSubdivisions([]); setCities([]); return }
    let live = true
    setLoading("subdivisions")
    client.subdivisions.list({ country: selection.country, locale }).then((r) => {
      if (live) { setSubdivisions(r.places); setLoading(null) }
    })
    return () => { live = false }
  }, [client, locale, selection.country])

  /**
   * Debounced, because each keystroke is a database query somebody pays for.
   *
   * 200ms is short enough to feel immediate and long enough that typing "bangkok"
   * costs one query rather than seven.
   */
  const searchCities = React.useMemo(() => {
    let timer: ReturnType<typeof setTimeout>
    return (q: string) => {
      clearTimeout(timer)
      if (!selection.country || q.length < 1) { setCities([]); return }
      timer = setTimeout(async () => {
        setLoading("cities")
        const r = await client.cities.search({
          country: selection.country!,
          subdivision: selection.subdivision,
          q,
          locale,
        })
        setCities(r.places)
        setLoading(null)
      }, 200)
    }
  }, [client, locale, selection.country, selection.subdivision])

  const t = {
    country: labels?.country ?? "Country",
    subdivision: labels?.subdivision ?? "State or province",
    city: labels?.city ?? "City",
    search: labels?.search ?? "Type to search",
    empty: labels?.empty ?? "Nothing found",
  }

  return (
    <div className={cn("grid gap-4 sm:grid-cols-3", className)}>
      <Picker
        label={t.country}
        placeholder={t.country}
        empty={t.empty}
        options={countries}
        value={selection.country ? `country:${selection.country}` : undefined}
        loading={loading === "countries"}
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
        loading={loading === "subdivisions"}
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
        loading={loading === "cities"}
        searchable
        onSearch={searchCities}
        markUntranslated={markUntranslated}
        onSelect={(id) => set({ ...selection, city: id })}
      />
    </div>
  )
}
