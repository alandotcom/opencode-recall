import { afterAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildFixture } from "./fixture.js"
import { latestCheckpoint, threadSessions } from "../src/scope.js"
import { render, search } from "../src/search.js"
import { messageText } from "../src/text.js"
import { resolveDatabasePath } from "../src/db.js"

const dir = mkdtempSync(join(tmpdir(), "recall-"))
const path = join(dir, "fixture.db")
buildFixture(path).close()
const db = new Database(path, { readonly: true })

afterAll(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const options = { limit: 10, snippetChars: 200, maxChars: 4000, beforeCheckpoint: false }

test("a thread is the root plus every descendant", () => {
  expect(threadSessions(db, "child-a").sort()).toEqual(["child-a", "child-b", "root"])
  expect(threadSessions(db, "root").sort()).toEqual(["child-a", "child-b", "root"])
})

test("an unknown session searches only itself", () => {
  expect(threadSessions(db, "ses_nonexistent")).toEqual(["ses_nonexistent"])
})

test("results never cross into another thread", () => {
  const hits = search(db, { ...options, sessionID: "child-a", query: "flexbox" })
  expect(hits.length).toBeGreaterThan(0)
  for (const hit of hits) expect(["root", "child-a", "child-b"]).toContain(hit.sessionID)
  expect(hits.some((h) => h.sessionID.startsWith("stranger"))).toBe(false)
})

test("sibling subagent work is reachable", () => {
  const hits = search(db, { ...options, sessionID: "root", query: "viewport width" })
  expect(hits.map((h) => h.sessionID)).toContain("child-a")
})

test("query terms do not have to be a contiguous phrase", () => {
  const hits = search(db, { ...options, sessionID: "root", query: "width keyed viewport" })
  expect(hits.map((h) => [h.sessionID, h.seq])).toContainEqual(["child-a", 1])
})

test("singular query terms match plural message terms", () => {
  const hits = search(db, { ...options, sessionID: "root", query: "subagent" })
  expect(hits.map((h) => [h.sessionID, h.seq])).toContainEqual(["child-b", 1])
})

test("BM25 ranks messages matching more query terms above partial matches", () => {
  const hits = search(db, { ...options, sessionID: "root", query: "cache alignment" })
  expect(hits[0]).toMatchObject({ sessionID: "root", seq: 2 })
})

test("before_checkpoint keeps only what fell out of context", () => {
  const before = search(db, { ...options, sessionID: "root", query: "alignment", beforeCheckpoint: true })
  const seqs = before.filter((h) => h.sessionID === "root").map((h) => h.seq)
  expect(seqs.every((seq) => seq < 3)).toBe(true)
  expect(seqs).toContain(2)
})

test("checkpoint lookup reports the newest compaction, or nothing", () => {
  expect(latestCheckpoint(db, "root")).toBe(3)
  expect(latestCheckpoint(db, "child-a")).toBeUndefined()
})

test("an empty result says so without implying the topic is unknown", () => {
  const hits = search(db, { ...options, sessionID: "child-a", query: "kubernetes" })
  expect(hits).toEqual([])
  expect(render(hits, 4000)).toContain("No matches in this thread")
})

test("rendering respects the character cap", () => {
  const hits = search(db, { ...options, sessionID: "root", query: "a" })
  const out = render(hits, 300)
  expect(out.length).toBeLessThanOrEqual(400)
})

test("assistant reasoning blobs are not searched or shown", () => {
  const text = messageText("assistant", {
    content: [
      { type: "reasoning", text: "", reasoningEncryptedContent: "secret" },
      { type: "text", text: "visible" },
    ],
  })
  expect(text).toBe("visible")
})

test("user messages read their text field directly", () => {
  expect(messageText("user", { text: "hello" })).toBe("hello")
})

test("OPENCODE_DB overrides the default path", () => {
  expect(resolveDatabasePath({ OPENCODE_DB: "/tmp/custom.db" } as NodeJS.ProcessEnv)).toBe("/tmp/custom.db")
  expect(resolveDatabasePath({ HOME: "/home/x" } as NodeJS.ProcessEnv)).toContain("opencode.db")
})
