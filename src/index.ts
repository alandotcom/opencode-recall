import { Plugin } from "@opencode-ai/plugin"
import type { Database } from "bun:sqlite"
import { openDatabase, resolveDatabasePath } from "./db.js"
import { render, search } from "./search.js"

/** Defaults, each overridable per install through the plugin's `options`. */
const DEFAULTS = {
  limit: 10,
  snippetChars: 400,
  maxChars: 6000,
}

const DESCRIPTION = [
  "Search earlier messages in the current thread, including messages that have dropped out of",
  "context after a compaction. Use it before re-reading files or re-deriving something the thread",
  "may already have settled: a decision, an error and its fix, a test result, a rejected approach.",
  "Only this thread is searched, so an empty result means nothing matched here, not that the topic",
  "never came up. Results use BM25 term relevance, so describe the subject with a few distinctive",
  "words or identifiers. Terms do not need to be adjacent or in the same order.",
].join(" ")

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Words or identifiers describing what to find. Distinctive terms rank best.",
    },
    limit: {
      type: "number",
      description: `Maximum matches to return (default ${DEFAULTS.limit}).`,
    },
    before_checkpoint: {
      type: "boolean",
      description:
        "Restrict to messages from before this session's most recent compaction, which is the part the model can no longer see. Ignored when the session has never compacted.",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const

type RecallInput = {
  query: string
  limit?: number
  before_checkpoint?: boolean
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

export default Plugin.define({
  id: "opencode-recall",
  async setup(ctx) {
    const options = ctx.options ?? {}
    const limitDefault = positiveInteger(options.limit, DEFAULTS.limit)
    const snippetChars = positiveInteger(options.snippetChars, DEFAULTS.snippetChars)
    const maxChars = positiveInteger(options.maxChars, DEFAULTS.maxChars)
    const databasePath =
      typeof options.database === "string" && options.database.length > 0
        ? options.database
        : resolveDatabasePath()

    // Opened on first use so a missing database is reported to the model as a
    // tool result rather than breaking plugin load for everyone.
    let db: Database | undefined

    const registration = await ctx.tool.transform((draft) => {
      draft.add({
        name: "recall",
        description: DESCRIPTION,
        input: INPUT_SCHEMA,
        options: { codemode: false },
        async execute(raw: unknown, context) {
          // The host validates against INPUT_SCHEMA and hands the value back as
          // `unknown`, so narrow it here rather than trusting the shape.
          const input = (raw ?? {}) as RecallInput
          const query = typeof input.query === "string" ? input.query.trim() : ""
          if (query.length === 0) {
            return { content: "recall needs a non-empty query.", metadata: { truncated: false } }
          }

          try {
            db ??= openDatabase(databasePath)
          } catch (error) {
            return {
              content: `Could not open the opencode database at ${databasePath}: ${String(error)}`,
              metadata: { truncated: false },
            }
          }

          const hits = search(db, {
            sessionID: context.sessionID,
            query,
            limit: positiveInteger(input.limit, limitDefault),
            beforeCheckpoint: input.before_checkpoint === true,
            snippetChars,
          })

          const rendered = render(hits, maxChars)

          // Never return an `output` key. opencode calls Effect.die on a
          // result carrying `output` when the tool declares no output schema,
          // which fails every call rather than returning an error.
          return {
            content: rendered.content,
            // Our own cap already bounds this, so skip opencode's line/byte
            // truncation pass rather than have two limits disagree.
            metadata: {
              matches: hits.length,
              shown: rendered.shown,
              omitted: rendered.omitted,
              truncated: false,
            },
          }
        },
      })
    })

    return async () => {
      await registration.dispose()
      db?.close()
    }
  },
})
