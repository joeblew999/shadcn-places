/**
 * The D1 import protocol, against a fake transport.
 *
 * `scripts/places/load.ts` said a Worker "cannot do it at all — the import path
 * is CLI-only". It is a four-step HTTP protocol, and the steps that matter are
 * the ones with a guard on them: an etag that is checked twice, and an ingest
 * that must not run against bytes that are not ours.
 *
 * A real import blocks the database for its duration and needs a D1:Edit token,
 * so it is not something to run on every commit. What *can* run on every commit
 * is whether this client honours the protocol's guarantees — which is where the
 * dangerous bugs are, because "ingest somebody else's file" fails silently and
 * successfully.
 */

import { describe, it, expect } from "vitest"
import { etagOf, importSql, type D1ImportCredentials } from "../../src/etl/d1-import.ts"

const creds: D1ImportCredentials = {
  accountId: "acct",
  databaseId: "db",
  apiToken: "token",
}

const ok = (result: unknown) =>
  new Response(JSON.stringify({ success: true, result }), { headers: { "content-type": "application/json" } })

/**
 * A D1 that behaves. `uploadEtag` lets a test make storage return the wrong one.
 */
function fakeD1(opts: { hasFile?: boolean; uploadEtag?: string; failIngest?: string; polls?: number } = {}) {
  const calls: string[] = []
  let polls = opts.polls ?? 0
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = String(url)
    if (href.startsWith("https://upload.example/")) {
      calls.push("PUT upload")
      const body = String(init?.body ?? "")
      return new Response(null, { headers: { etag: `"${opts.uploadEtag ?? etagOf(body)}"` } })
    }
    const action = JSON.parse(String(init?.body ?? "{}")).action as string
    calls.push(action)
    if (action === "init") {
      return ok({ filename: "f.sql", ...(opts.hasFile ? {} : { upload_url: "https://upload.example/put" }) })
    }
    if (action === "ingest") {
      if (opts.failIngest) return ok({ status: "error", errors: [opts.failIngest] })
      return polls > 0
        ? ok({ status: "active", at_bookmark: "b0", messages: ["started"] })
        : ok({ status: "complete", num_queries: 13318, final_bookmark: "done" })
    }
    if (action === "poll") {
      polls--
      return polls > 0
        ? ok({ status: "active", at_bookmark: `b${polls}`, messages: [`working ${polls}`] })
        : ok({ status: "complete", num_queries: 13318, final_bookmark: "done" })
    }
    throw new Error(`unexpected action ${action}`)
  }
  return { impl, calls }
}

/** `importSql` uses the global fetch, so tests swap it and put it back. */
async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = impl as typeof fetch
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

describe("the D1 import protocol", () => {
  it("uploads, ingests, and reports what ran", async () => {
    const d1 = fakeD1()
    const result = await withFetch(d1.impl as typeof fetch, () =>
      importSql(creds, "DELETE FROM name;\n", { pollMs: 0 }),
    )
    expect(d1.calls).toEqual(["init", "PUT upload", "ingest"])
    expect(result.reused).toBe(false)
    expect(result.queries).toBe(13318)
  })

  it("skips the upload when D1 already holds the file", async () => {
    /**
     * The protocol being helpful, and worth handling rather than erroring on.
     *
     * A retried Workflow step recomputes the same SQL, produces the same MD5, and
     * D1 says it already has it. A client that insisted on an `upload_url` would
     * turn a free retry into a 34MB one.
     */
    const d1 = fakeD1({ hasFile: true })
    const result = await withFetch(d1.impl as typeof fetch, () => importSql(creds, "SELECT 1;\n", { pollMs: 0 }))
    expect(d1.calls).toEqual(["init", "ingest"])
    expect(result.reused).toBe(true)
  })

  it("refuses to ingest when storage returns a different etag", async () => {
    /**
     * The guard that matters most in this file.
     *
     * The upload can succeed while the stored bytes are not the ones we sent.
     * Ingesting then applies somebody else's file to the database, succeeds, and
     * reports success. There is no later check that would catch it.
     */
    const d1 = fakeD1({ uploadEtag: "0000000000000000000000000000dead" })
    await expect(
      withFetch(d1.impl as typeof fetch, () => importSql(creds, "DROP TABLE place;\n", { pollMs: 0 })),
    ).rejects.toThrow(/etag mismatch/)
    expect(d1.calls, "ingest must not have been reached").not.toContain("ingest")
  })

  it("polls until the import completes", async () => {
    const d1 = fakeD1({ polls: 3 })
    const seen: string[] = []
    const result = await withFetch(d1.impl as typeof fetch, () =>
      importSql(creds, "INSERT INTO name VALUES (1);\n", { pollMs: 0, onProgress: (m) => seen.push(m) }),
    )
    expect(d1.calls.filter((c) => c === "poll").length).toBeGreaterThan(1)
    expect(result.bookmark).toBe("done")
    expect(seen.some((m) => m.startsWith("working"))).toBe(true)
  })

  it("surfaces an import failure rather than returning quietly", async () => {
    const d1 = fakeD1({ failIngest: "near \"SELCT\": syntax error" })
    await expect(
      withFetch(d1.impl as typeof fetch, () => importSql(creds, "SELCT 1;\n", { pollMs: 0 })),
    ).rejects.toThrow(/syntax error/)
  })

  it("gives up rather than polling forever", async () => {
    // A hung import that is never reported is worse than a failed one: the
    // database is blocked for the duration and nothing says why.
    const d1 = fakeD1({ polls: 999 })
    await expect(
      withFetch(d1.impl as typeof fetch, () => importSql(creds, "SELECT 1;\n", { pollMs: 0, maxPolls: 3 })),
    ).rejects.toThrow(/did not complete/)
  })

  it("reports an API error with the reason Cloudflare gave", async () => {
    const failing = async () =>
      new Response(JSON.stringify({ success: false, errors: [{ message: "Authentication error" }] }), { status: 403 })
    await expect(
      withFetch(failing as unknown as typeof fetch, () => importSql(creds, "SELECT 1;\n", { pollMs: 0 })),
    ).rejects.toThrow(/Authentication error/)
  })
})

describe("the etag", () => {
  it("is the MD5 the protocol checks", () => {
    // Verified against `md5 -q` on the same bytes. WebCrypto has no MD5, so this
    // is node:crypto — used as a content fingerprint, which is the one job MD5 is
    // still fit for, and the alternative is not using D1's import API at all.
    expect(etagOf("SELECT 1;\n")).toBe("2bdf1665f56c0ce5b966d9c60a7f7eac")
  })

  it("is stable across string and bytes", () => {
    expect(etagOf(new TextEncoder().encode("SELECT 1;\n"))).toBe(etagOf("SELECT 1;\n"))
  })
})
