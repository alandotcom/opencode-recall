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

type SearchDocument = {
  sessionID: string
  seq: number
  role: string
  createdAt: number
  body: string
  terms: string[]
  frequencies: Map<string, number>
}

const BM25_K1 = 1.2
const BM25_B = 0.75

function tokenize(input: string): string[] {
  return input.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
}

function termFrequencies(terms: string[]): Map<string, number> {
  const frequencies = new Map<string, number>()
  for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1)
  return frequencies
}

function snippetAround(body: string, query: string, terms: string[], width: number): string {
  const lower = body.toLowerCase()
  const phraseAt = lower.indexOf(query.toLowerCase())
  const termPositions = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0)
  const at = phraseAt >= 0 ? phraseAt : termPositions.length > 0 ? Math.min(...termPositions) : -1
  if (at < 0) return body.slice(0, width)
  const lead = Math.floor(width / 3)
  const start = Math.max(0, at - lead)
  return (start > 0 ? "…" : "") + body.slice(start, start + width).replace(/\s+/g, " ").trim() + "…"
}

function bm25Scores(documents: SearchDocument[], queryTerms: string[]): Map<SearchDocument, number> {
  const scores = new Map<SearchDocument, number>()
  if (documents.length === 0) return scores

  const averageLength = documents.reduce((sum, document) => sum + document.terms.length, 0) / documents.length
  for (const term of new Set(queryTerms)) {
    const documentFrequency = documents.reduce(
      (count, document) => count + (document.frequencies.has(term) ? 1 : 0),
      0,
    )
    if (documentFrequency === 0) continue

    const inverseDocumentFrequency = Math.log(
      1 + (documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5),
    )
    for (const document of documents) {
      const termFrequency = document.frequencies.get(term) ?? 0
      if (termFrequency === 0) continue
      const lengthNormalization = 1 - BM25_B + BM25_B * (document.terms.length / averageLength)
      const termScore =
        inverseDocumentFrequency *
        ((termFrequency * (BM25_K1 + 1)) / (termFrequency + BM25_K1 * lengthNormalization))
      scores.set(document, (scores.get(document) ?? 0) + termScore)
    }
  }
  return scores
}

/**
 * Searches the calling session's thread and nothing else.
 *
 * There is deliberately no way to widen this to other threads or to every
 * session on disk. A cross-thread match looks authoritative and is usually from
 * unrelated work, which is worse than returning nothing.
 */
export function search(db: Database, options: SearchOptions): Hit[] {
  const query = options.query.trim()
  const queryTerms = tokenize(query)
  if (queryTerms.length === 0) return []

  const sessions = threadSessions(db, options.sessionID)
  const placeholders = sessions.map(() => "?").join(",")
  const params: (string | number)[] = [...sessions]

  let sql =
    `select session_id as sessionID, seq, type, time_created as createdAt, data ` +
    `from session_message ` +
    `where session_id in (${placeholders}) and type in ('user','assistant')`

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

  const documents: SearchDocument[] = []
  for (const row of rows) {
    let parsed: unknown
    try {
      parsed = JSON.parse(row.data)
    } catch {
      continue
    }
    const body = messageText(row.type, parsed)
    if (body.length === 0) continue
    const terms = tokenize(body)
    documents.push({
      sessionID: row.sessionID,
      seq: row.seq,
      role: row.type,
      createdAt: row.createdAt,
      body,
      terms,
      frequencies: termFrequencies(terms),
    })
  }

  const scores = bm25Scores(documents, queryTerms)
  return [...scores]
    .sort(([left, leftScore], [right, rightScore]) => rightScore - leftScore || right.createdAt - left.createdAt)
    .slice(0, options.limit)
    .map(([document]) => ({
      sessionID: document.sessionID,
      seq: document.seq,
      role: document.role,
      createdAt: document.createdAt,
      occurrences: queryTerms.reduce((sum, term) => sum + (document.frequencies.get(term) ?? 0), 0),
      snippet: snippetAround(document.body, query, queryTerms, options.snippetChars),
    }))
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
