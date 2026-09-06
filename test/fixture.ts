import { Database } from "bun:sqlite"

/**
 * Builds a database with just the columns recall reads, shaped like a real
 * thread: a root session, two subagent children, and one unrelated session that
 * must never show up in results.
 */
export function buildFixture(path: string): Database {
  const db = new Database(path, { create: true })
  db.run(`create table session_v2 (id text primary key, parent_id text, directory text)`)
  db.run(
    `create table session_message (id text primary key, session_id text, type text, seq integer, time_created integer, data text)`,
  )

  const sessions: [string, string | null][] = [
    ["root", null],
    ["child-a", "root"],
    ["child-b", "root"],
    ["stranger", null],
    ["stranger-child", "stranger"],
  ]
  for (const [id, parent] of sessions) {
    db.run(`insert into session_v2 (id, parent_id, directory) values (?, ?, ?)`, [id, parent, "/tmp/project"])
  }

  let messageID = 0
  const add = (session: string, seq: number, type: string, text: string, createdAt: number) => {
    const data =
      type === "user"
        ? JSON.stringify({ text })
        : JSON.stringify({
            content: [
              { type: "reasoning", text: "", reasoningEncryptedContent: "x".repeat(500) },
              { type: "text", text },
            ],
          })
    db.run(`insert into session_message (id, session_id, type, seq, time_created, data) values (?, ?, ?, ?, ?, ?)`, [
      `msg-${messageID++}`,
      session,
      type,
      seq,
      createdAt,
      data,
    ])
  }

  const now = Date.now()
  add("root", 1, "user", "please fix the widget alignment", now - 90_000)
  add("root", 2, "assistant", "The alignment bug came from a stale flexbox cache.", now - 80_000)
  db.run(
    `insert into session_message (id, session_id, type, seq, time_created, data) values (?, ?, ?, ?, ?, ?)`,
    ["msg-compaction", "root", "compaction", 3, now - 70_000, JSON.stringify({ reason: "overflow" })],
  )
  add("root", 4, "assistant", "Continuing after compaction, alignment still needs a regression test.", now - 60_000)
  add("root", 5, "assistant", "The connection remains active.", now - 55_000)
  add("child-a", 1, "assistant", "Subagent found the flexbox cache is keyed on viewport width.", now - 50_000)
  add("child-b", 1, "assistant", "Unrelated subagents connected the logging transport.", now - 40_000)
  add("stranger", 1, "assistant", "A different thread also discussed flexbox alignment at length.", now - 30_000)
  add("stranger-child", 1, "assistant", "More flexbox talk from the other thread.", now - 20_000)

  return db
}
