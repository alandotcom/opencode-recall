import { Database } from "bun:sqlite"
import { latestCheckpoint, threadSessions } from "./scope.js"
import { messageText } from "./text.js"

export type SearchOptions = {
  sessionID: string
  query: string
  limit: number
  beforeCheckpoint: boolean
  snippetChars: number
}

export type Hit = {
  sessionID: string
  seq: number
  role: string
  createdAt: number
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

type RankedDocument = {
  document: SearchDocument
  exactScore: number
  stemmedScore: number
  markedSnippet: string
  matchedTerms: Set<string>
}

const MATCH_START = "\u0001"
const MATCH_END = "\u0002"

function formatSnippet(markedSnippet: string, width: number): string {
  if (width <= 0) return ""
  const marked = markedSnippet.replace(/\s+/g, " ").trim()
  const markerAt = marked.indexOf(MATCH_START)
  const matchAt =
    markerAt < 0
      ? 0
      : marked.slice(0, markerAt).replaceAll(MATCH_START, "").replaceAll(MATCH_END, "").length
  const plain = marked.replaceAll(MATCH_START, "").replaceAll(MATCH_END, "")
  if (plain.length <= width) return plain

  const start = Math.max(0, matchAt - Math.floor(width / 3))
  const hasPrefix = start > 0
  const availableAfterPrefix = width - (hasPrefix ? 1 : 0)
  const hasSuffix = availableAfterPrefix > 0 && start + availableAfterPrefix < plain.length
  const contentWidth = availableAfterPrefix - (hasSuffix ? 1 : 0)
  return `${hasPrefix ? "…" : ""}${plain.slice(start, start + contentWidth).trim()}${hasSuffix ? "…" : ""}`
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

    const query = ftsQuery([...new Set(queryTerms)])
    const exactScores = index
      .query<{ rowID: number; score: number }, [string]>(
        "select rowid as rowID, -bm25(exact_docs) as score from exact_docs where exact_docs match ?",
      )
      .all(query)
    const stemmedScores = index
      .query<{ rowID: number; score: number; markedSnippet: string }, [string]>(
        `select rowid as rowID, -bm25(stemmed_docs) as score,
                highlight(stemmed_docs, 0, char(1), char(2)) as markedSnippet
         from stemmed_docs where stemmed_docs match ?`,
      )
      .all(query)

    const ranked = new Map<number, RankedDocument>()
    for (const row of stemmedScores) {
      const document = documents[row.rowID - 1]
      if (!document) throw new Error(`FTS returned unknown row ${row.rowID}`)
      ranked.set(row.rowID, {
        document,
        exactScore: 0,
        stemmedScore: row.score,
        markedSnippet: row.markedSnippet,
        matchedTerms: new Set<string>(),
      })
    }
    for (const row of exactScores) {
      const result = ranked.get(row.rowID)
      if (!result) throw new Error(`Exact FTS result ${row.rowID} was absent from stemmed results`)
      result.exactScore = row.score
    }

    const stemmedMatches = index.query<{ rowID: number }, [string]>(
      "select rowid as rowID from stemmed_docs where stemmed_docs match ?",
    )
    for (const term of new Set(queryTerms)) {
      const termQuery = ftsQuery([term])
      for (const row of stemmedMatches.all(termQuery)) {
        const result = ranked.get(row.rowID)
        if (!result) throw new Error(`FTS term result ${row.rowID} was absent from ranked results`)
        result.matchedTerms.add(term)
      }
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
      snippet: formatSnippet(ranked.markedSnippet, options.snippetChars),
    }))
}

export type RenderedSearch = {
  content: string
  shown: number
  omitted: number
}

/** Renders hits for the model, including all framing text within the cap. */
export function render(hits: Hit[], maxChars: number): RenderedSearch {
  const cap = Math.max(0, Math.floor(maxChars))
  if (hits.length === 0) {
    const message =
      "No matches in this thread. Recall only searches the current thread, so this does not mean the topic never came up elsewhere."
    return { content: message.slice(0, cap), shown: 0, omitted: 0 }
  }

  const blocks = hits.map((hit) => {
    const when = new Date(hit.createdAt).toISOString().replace("T", " ").slice(0, 16)
    return `[${when}] ${hit.role} ${hit.sessionID}#${hit.seq}\n${hit.snippet}`
  })

  for (let shown = hits.length; shown >= 0; shown--) {
    const omitted = hits.length - shown
    const parts = blocks.slice(0, shown)
    if (omitted > 0) {
      parts.push(`(${omitted} further match${omitted === 1 ? "" : "es"} not shown; narrow the query)`)
    }
    const content = parts.join("\n\n")
    if (content.length <= cap) return { content, shown, omitted }
  }

  const notice = `(${hits.length} further match${hits.length === 1 ? "" : "es"} not shown; narrow the query)`
  return { content: notice.slice(0, cap), shown: 0, omitted: hits.length }
}
