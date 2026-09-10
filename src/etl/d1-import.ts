/**
 * Bulk-loading D1 from a Worker, which this repository said was impossible.
 *
 * The claim, in `scripts/places/load.ts`:
 *
 *   > `wrangler d1 execute --file` does the bulk load in one command, and a
 *   > Worker cannot do it at all — the import path is CLI-only.
 *
 * Wrangler is not doing anything a Worker cannot. It calls a four-step HTTP
 * protocol, recovered from its own source because the documentation search does
 * not surface it:
 *
 *   1. POST …/import  { action: "init", etag }        → an upload_url, or "already have it"
 *   2. PUT  upload_url  <the SQL>                     → the response etag must match
 *   3. POST …/import  { action: "ingest", filename, etag }
 *   4. POST …/import  { action: "poll", current_bookmark }  until status is complete
 *
 * The `etag` is an **MD5** of the file, and it is not decorative: step 2 verifies
 * it and step 3 refuses a mismatch. It is how D1 knows a re-run is the same file
 * and can skip the upload entirely.
 *
 * ## What this costs while it runs
 *
 * An import blocks the database. Cloudflare's own warning: *"this process may
 * take some time, during which your D1 database will be unavailable to serve
 * queries."* That is the reason `places load` writes a delta by default — a full
 * rewrite is 81MB and blocks reads for the duration, to change a handful of rows.
 *
 * ## The credential
 *
 * Needs an API token with D1 edit permission, as a Worker secret. That is a real
 * difference from the binding: the binding can query and cannot bulk-load, and
 * this can bulk-load and is therefore worth scoping narrowly.
 */

import { createHash } from "node:crypto"

export interface D1ImportCredentials {
  accountId: string
  databaseId: string
  /** An API token with D1:Edit. `wrangler d1 execute` uses your OAuth session instead. */
  apiToken: string
}

interface ImportResponse {
  success: boolean
  errors?: { message: string }[]
  messages?: string[]
  result?: {
    filename?: string
    upload_url?: string
    status?: "active" | "complete" | "error"
    at_bookmark?: string
    messages?: string[]
    errors?: string[]
    /**
     * Nested, and the nesting is easy to miss.
     *
     * The envelope is `{ success, result: { status, at_bookmark, result: { … } } }`
     * — the counts live one level further down than the status does. Reading them
     * off the outer object yields `undefined`, which becomes 0, which reports a
     * successful import of nothing. It did exactly that on the first live run:
     * "Processed 3 queries." in the messages beside `queries: 0` in the return.
     */
    result?: {
      final_bookmark?: string
      num_queries?: number
      meta?: {
        rows_read?: number
        rows_written?: number
        size_after?: number
        duration?: number
      }
    }
  }
}

const API = "https://api.cloudflare.com/client/v4"

async function post(
  creds: D1ImportCredentials,
  body: Record<string, unknown>,
): Promise<NonNullable<ImportResponse["result"]>> {
  const res = await fetch(`${API}/accounts/${creds.accountId}/d1/database/${creds.databaseId}/import`, {
    method: "POST",
    headers: { authorization: `Bearer ${creds.apiToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const json = (await res.json()) as ImportResponse
  if (!res.ok || !json.success) {
    const why = json.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`
    throw new Error(`D1 import ${String(body.action)} failed: ${why}`)
  }
  if (!json.result) throw new Error(`D1 import ${String(body.action)} returned no result`)
  return json.result
}

/**
 * MD5, because that is what the protocol checks.
 *
 * WebCrypto has no MD5 — deliberately, it is not a security hash — so this uses
 * `node:crypto`, which Workers support. It is being used as a content
 * fingerprint, which is the one job MD5 is still fit for, and the alternative is
 * not using D1's import API.
 */
export function etagOf(sql: string | Uint8Array): string {
  return createHash("md5").update(sql as never).digest("hex")
}

export interface ImportOutcome {
  /** True when D1 already had this exact file and the upload was skipped. */
  reused: boolean
  queries: number
  /** What the database actually did. `rowsWritten` is the number worth checking. */
  rowsRead: number
  rowsWritten: number
  /** Database size after the import, in bytes. */
  sizeAfter: number
  bookmark?: string
  messages: string[]
}

/**
 * Upload SQL and import it, returning when D1 says it is done.
 *
 * `onProgress` exists because an import of a full load runs for minutes and a
 * Workflow step that logs nothing is indistinguishable from a hung one.
 */
export async function importSql(
  creds: D1ImportCredentials,
  sql: string,
  options: { onProgress?: (message: string) => void; pollMs?: number; maxPolls?: number } = {},
): Promise<ImportOutcome> {
  const say = options.onProgress ?? (() => {})
  const pollMs = options.pollMs ?? 1000
  const maxPolls = options.maxPolls ?? 600
  const etag = etagOf(sql)

  const init = await post(creds, { action: "init", etag })
  const messages: string[] = [...(init.messages ?? [])]
  let reused = true

  /**
   * No `upload_url` means D1 already holds this exact file.
   *
   * Worth handling rather than treating as an error: a retried Workflow step
   * re-computes the same SQL, gets the same MD5, and skips a 34MB upload. That
   * is the protocol being helpful, and a client that insisted on an upload_url
   * would turn a free retry into an expensive one.
   */
  if (init.upload_url) {
    reused = false
    say(`uploading ${(sql.length / 1048576).toFixed(1)}MB`)
    const put = await fetch(init.upload_url, { method: "PUT", body: sql })
    if (!put.ok) throw new Error(`upload failed: HTTP ${put.status} ${await put.text()}`)
    const returned = put.headers.get("etag")?.replace(/^"|"$/g, "")
    if (returned !== etag) {
      // The upload succeeded and the bytes are not ours. Ingesting now would
      // apply somebody else's file to the database.
      throw new Error(`upload etag mismatch: sent ${etag}, storage returned ${returned}`)
    }
  } else {
    say("D1 already has this file — skipping the upload")
  }

  const filename = init.filename
  if (!filename) throw new Error("init returned no filename to ingest")

  say("ingesting")
  let state = await post(creds, { action: "ingest", filename, etag })
  messages.push(...(state.messages ?? []))

  for (let i = 0; i < maxPolls; i++) {
    if (state.status === "complete") {
      const done = state.result ?? {}
      const meta = done.meta ?? {}
      return {
        reused,
        queries: done.num_queries ?? 0,
        rowsRead: meta.rows_read ?? 0,
        rowsWritten: meta.rows_written ?? 0,
        sizeAfter: meta.size_after ?? 0,
        bookmark: done.final_bookmark,
        messages,
      }
    }
    if (state.status === "error") {
      throw new Error(`D1 import failed: ${(state.errors ?? []).join("; ") || "no reason given"}`)
    }
    await new Promise((r) => setTimeout(r, pollMs))
    state = await post(creds, { action: "poll", current_bookmark: state.at_bookmark })
    for (const m of state.messages ?? []) { messages.push(m); say(m) }
  }
  throw new Error(`D1 import did not complete after ${maxPolls} polls`)
}
