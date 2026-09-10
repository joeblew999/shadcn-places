/**
 * Three tables and one rule: no query may scan the world.
 *
 * D1 bills rows *scanned*, not rows returned, and since 1 September 2026 a free
 * plan's queries fail rather than throttle once the daily row-read limit is hit.
 * So `name LIKE '%bangkok%'` across 152,970 cities is not slow, it is a bill and
 * then an outage — per keystroke. A leading wildcard cannot use a B-tree index.
 *
 * Every index here exists to make the cascade — country, then subdivision, then
 * city — the only shape a caller can express. That the cheap query and the usable
 * interface are the same query is luck, and it is worth not squandering.
 */

import { sqliteTable, text, integer, real, index, primaryKey } from "drizzle-orm/sqlite-core"

/**
 * A place, of any tier. One table rather than three.
 *
 * Countries, subdivisions and cities differ in almost nothing but their parent and
 * their number, and three tables would mean three of every query, three indexes to
 * keep in step, and a union wherever something wants "a place". The `type` column
 * costs a byte.
 */
export const place = sqliteTable(
  "place",
  {
    /** `country:BR`, `subdivision:BR-SP`, `city:3448439`. Prefixed so an id is self-describing in a log. */
    id: text("id").primaryKey(),
    type: text("type", { enum: ["country", "subdivision", "city"] }).notNull(),
    /**
     * The romanised name. Never null, and never absent from any source.
     *
     * This is what a caller gets when their language has nothing, and it is why
     * the API can promise to always return a name. Naming it `pivot` rather than
     * `name_en` is deliberate: it is a fallback, not English.
     */
    pivot: text("pivot").notNull(),
    /** `country:BR` for a subdivision, `subdivision:BR-SP` for a city. Null only for countries. */
    parentId: text("parent_id"),
    /** ISO-3166-1 alpha-2, denormalised onto cities so the cascade can skip a join. */
    countryCode: text("country_code"),
    lat: real("lat"),
    lon: real("lon"),
    population: integer("population"),
    /** The Wikidata QID, where a source gave one. The label join's key. */
    wikidataId: text("wikidata_id"),
  },
  (t) => [
    // The cascade's two steps. Without these, listing a country's subdivisions is
    // a full scan of every place on earth.
    index("place_parent_idx").on(t.parentId),
    index("place_country_type_idx").on(t.countryCode, t.type),
    /**
     * Prefix search, scoped.
     *
     * `(country_code, type, pivot)` lets `WHERE country_code = ? AND type = 'city'
     * AND pivot >= ? AND pivot < ?` walk the index instead of the table. It is why
     * the API takes a country before it takes a query string, rather than out of
     * politeness.
     */
    index("place_prefix_idx").on(t.countryCode, t.type, t.pivot),
  ],
)

/**
 * A name, per place and locale, with how we came to have it.
 *
 * `kind` is the column that makes this honest. A value identical to the pivot is
 * `romanised` however its source described it — correct for German, an absence
 * dressed as a presence for Thai. Recording that distinction is the difference
 * between a coverage report that means something and one that always says 100%.
 */
export const name = sqliteTable(
  "name",
  {
    placeId: text("place_id").notNull().references(() => place.id),
    /** BCP-47 as the source wrote it. `und` for a script-neutral romanisation. */
    locale: text("locale").notNull(),
    value: text("value").notNull(),
    /** `cldr` | `geonames` | `dr5hn` | `wikidata`. What an attribution line is built from. */
    source: text("source").notNull(),
    kind: text("kind", { enum: ["override", "translated", "native", "romanised", "transliterated"] }).notNull(),
  },
  (t) => [
    // One name per (place, locale): the merge already resolved the competition, so
    // the database does not have to hold the losers or the caller pick between them.
    primaryKey({ columns: [t.placeId, t.locale] }),
    // Serving a page means "this place, this locale" — the primary key covers it.
    // This one covers the other question: "what does locale X actually have?",
    // which is the coverage report and the reason a language can be assessed
    // before it is adopted rather than after somebody complains.
    index("name_locale_kind_idx").on(t.locale, t.kind),
  ],
)

/**
 * Coverage, precomputed — because reporting it was the most expensive query here.
 *
 * `/api/matrix` and `/api/locales` aggregated the whole `name` table on every
 * request: 1.18 million rows scanned, 7.3 seconds, and billed every time. That is
 * precisely the mistake the city search is shaped to avoid, committed in the
 * endpoints whose job is to report on it.
 *
 * The numbers change only when the data is loaded, so they are computed then. Two
 * thousand rows instead of a million-row scan, and the endpoints become a read of
 * a table small enough to be free.
 *
 * Denormalised on purpose. It can be rebuilt from `name` in one statement, and if
 * it is ever wrong the answer is to reload rather than to reconcile.
 */
export const coverage = sqliteTable(
  "coverage",
  {
    locale: text("locale").notNull(),
    type: text("type", { enum: ["country", "subdivision", "city"] }).notNull(),
    /** Places with any name in this locale. The figure a Latin-script reader wants. */
    named: integer("named").notNull(),
    /** Excluding romanised fallbacks. The figure every other script wants. */
    real: integer("real").notNull(),
  },
  (t) => [primaryKey({ columns: [t.locale, t.type] })],
)

export const schema = { place, name, coverage }
