import { Database } from "bun:sqlite"
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
}

function tokenize(input: string): string[] {
  return input.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
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

type RankedDocument = {
  document: SearchDocument
  exactScore: number
  stemmedScore: number
  matchedTerms: Set<string>
}

function ftsQuery(terms: string[]): string {
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ")
}

function rankDocuments(documents: SearchDocument[], queryTerms: string[]): RankedDocument[] {
  if (documents.length === 0) return []

  // Each call gets its own index. This keeps concurrent recalls independent
  // and leaves opencode's database read-only.
  const index = new Database(":memory:")
  try {
    index.run(`create virtual table exact_docs using fts5(body, tokenize = "unicode61 tokenchars '_'")`)
    index.run(
      `create virtual table stemmed_docs using fts5(body, tokenize = "porter unicode61 tokenchars '_'")`,
    )
    const insertExact = index.prepare("insert into exact_docs(rowid, body) values (?, ?)")
    const insertStemmed = index.prepare("insert into stemmed_docs(rowid, body) values (?, ?)")
    documents.forEach((document, position) => {
      const rowID = position + 1
      insertExact.run(rowID, document.body)
      insertStemmed.run(rowID, document.body)
    })

    const ranked = new Map<number, RankedDocument>()
    const getRanked = (rowID: number): RankedDocument => {
      const existing = ranked.get(rowID)
      if (existing) return existing
      const created = {
        document: documents[rowID - 1]!,
        exactScore: 0,
        stemmedScore: 0,
        matchedTerms: new Set<string>(),
      }
      ranked.set(rowID, created)
      return created
    }

    const query = ftsQuery([...new Set(queryTerms)])
    const exactScores = index
      .query<{ rowID: number; score: number }, [string]>(
        "select rowid as rowID, -bm25(exact_docs) as score from exact_docs where exact_docs match ?",
      )
      .all(query)
    const stemmedScores = index
      .query<{ rowID: number; score: number }, [string]>(
        "select rowid as rowID, -bm25(stemmed_docs) as score from stemmed_docs where stemmed_docs match ?",
      )
      .all(query)
    for (const row of exactScores) getRanked(row.rowID).exactScore = row.score
    for (const row of stemmedScores) getRanked(row.rowID).stemmedScore = row.score

    const exactMatches = index.query<{ rowID: number }, [string]>(
      "select rowid as rowID from exact_docs where exact_docs match ?",
    )
    const stemmedMatches = index.query<{ rowID: number }, [string]>(
      "select rowid as rowID from stemmed_docs where stemmed_docs match ?",
    )
    for (const term of new Set(queryTerms)) {
      const termQuery = ftsQuery([term])
      for (const row of exactMatches.all(termQuery)) getRanked(row.rowID).matchedTerms.add(term)
      for (const row of stemmedMatches.all(termQuery)) getRanked(row.rowID).matchedTerms.add(term)
    }

    return [...ranked.values()]
  } finally {
    index.close()
  }
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
    documents.push({
      sessionID: row.sessionID,
      seq: row.seq,
      role: row.type,
      createdAt: row.createdAt,
      body,
    })
  }

  const uniqueTermCount = new Set(queryTerms).size
  return rankDocuments(documents, queryTerms)
    .sort((left, right) => {
      const score = (ranked: RankedDocument) => {
        const coverage = ranked.matchedTerms.size / uniqueTermCount
        return (2 * ranked.exactScore + ranked.stemmedScore) * coverage * coverage
      }
      return score(right) - score(left) || right.document.createdAt - left.document.createdAt
    })
    .slice(0, options.limit)
    .map((ranked) => ({
      sessionID: ranked.document.sessionID,
      seq: ranked.document.seq,
      role: ranked.document.role,
      createdAt: ranked.document.createdAt,
      occurrences: ranked.matchedTerms.size,
      snippet: snippetAround(ranked.document.body, query, queryTerms, options.snippetChars),
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
