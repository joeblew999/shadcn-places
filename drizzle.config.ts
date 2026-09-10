import type { Config } from "drizzle-kit"

/**
 * Migrations for the place database.
 *
 * `dialect: sqlite` rather than `d1-http` deliberately: the migrations are also
 * how somebody self-hosting stands up their own copy from the published dumps,
 * and that person has SQLite, not our account.
 */
export default {
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
} satisfies Config
