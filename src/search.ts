import type { Database } from "bun:sqlite"
import { latestCheckpoint, threadSessions } from "./scope.js"
import { messageText } from "./text.js"

export type SearchOptions = {
  sessionID: string
  query: string
  limit: number
  beforeCheckpoint: boolean
  snippetChars: number
  maxChars: number
}

export type Hit = {
  sessionID: string
  seq: number
  role: string
  createdAt: number
  occurrences: number
  snippet: string
}

const RECENCY_HALF_LIFE_MS = 24 * 60 * 60 * 1000

/**
 * Ranks a hit by recency, nudged up when the query appears more than once.
 *
 * Plain substring matching is noisy: on a real thread, one common word matched
 * roughly a third of all messages. Ranking plus a hard output cap is what makes
 * the result readable, which matters more here than search sophistication.
 */
function score(hit: Hit, now: number): number {
  const ageHalfLives = (now - hit.createdAt) / RECENCY_HALF_LIFE_MS
  const recency = Math.pow(0.5, ageHalfLives)
  return recency * (1 + Math.log2(hit.occurrences + 1))
}

function snippetAround(body: string, needle: string, width: number): string {
  const at = body.toLowerCase().indexOf(needle)
  if (at < 0) return body.slice(0, width)
  const lead = Math.floor(width / 3)
  const start = Math.max(0, at - lead)
  return (start > 0 ? "…" : "") + body.slice(start, start + width).replace(/\s+/g, " ").trim() + "…"
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let at = haystack.indexOf(needle)
  while (at >= 0) {
    count++
    at = haystack.indexOf(needle, at + needle.length)
  }
  return count
}

/**
 * Searches the calling session's thread and nothing else.
 *
 * There is deliberately no way to widen this to other threads or to every
 * session on disk. A cross-thread match looks authoritative and is usually from
 * unrelated work, which is worse than returning nothing.
 */
export function search(db: Database, options: SearchOptions): Hit[] {
  const needle = options.query.toLowerCase().trim()
  if (needle.length === 0) return []

  const sessions = threadSessions(db, options.sessionID)
  const placeholders = sessions.map(() => "?").join(",")
  const params: (string | number)[] = [...sessions]

  let sql =
    `select session_id as sessionID, seq, type, time_created as createdAt, data ` +
    `from session_message ` +
    `where session_id in (${placeholders}) and type in ('user','assistant') and lower(data) like ?`
  params.push(`%${needle}%`)

  if (options.beforeCheckpoint) {
    const checkpoint = latestCheckpoint(db, options.sessionID)
    // No checkpoint means nothing has fallen out of context yet, so the filter
    // would hide everything rather than narrowing anything.
    if (checkpoint !== undefined) {
      sql += ` and (session_id != ? or seq < ?)`
      params.push(options.sessionID, checkpoint)
    }
  }

  const rows = db
    .query<{ sessionID: string; seq: number; type: string; createdAt: number; data: string }, any[]>(sql)
    .all(...params)

  const now = Date.now()
  const hits: Hit[] = []
  for (const row of rows) {
    let parsed: unknown
    try {
      parsed = JSON.parse(row.data)
    } catch {
      continue
    }
    const body = messageText(row.type, parsed)
    if (body.length === 0) continue
    const lower = body.toLowerCase()
    // The LIKE ran against the raw JSON, so a match can live in metadata we
    // never show. Only keep hits whose visible prose actually contains it.
    if (!lower.includes(needle)) continue
    hits.push({
      sessionID: row.sessionID,
      seq: row.seq,
      role: row.type,
      createdAt: row.createdAt,
      occurrences: countOccurrences(lower, needle),
      snippet: snippetAround(body, needle, options.snippetChars),
    })
  }

  hits.sort((a, b) => score(b, now) - score(a, now))
  return hits.slice(0, options.limit)
}

/** Renders hits as text for the model, truncated to stay within the cap. */
export function render(hits: Hit[], maxChars: number): string {
  if (hits.length === 0) {
    return "No matches in this thread. Recall only searches the current thread, so this does not mean the topic never came up elsewhere."
  }
  const lines: string[] = []
  let used = 0
  let shown = 0
  for (const hit of hits) {
    const when = new Date(hit.createdAt).toISOString().replace("T", " ").slice(0, 16)
    const block = `[${when}] ${hit.role} ${hit.sessionID}#${hit.seq}\n${hit.snippet}\n`
    if (used + block.length > maxChars) break
    lines.push(block)
    used += block.length
    shown++
  }
  const omitted = hits.length - shown
  if (omitted > 0) lines.push(`(${omitted} further match${omitted === 1 ? "" : "es"} not shown; narrow the query)`)
  return lines.join("\n")
}
