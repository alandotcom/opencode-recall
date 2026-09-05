# Working in this repository

`opencode-recall` is an opencode v2 plugin. It adds one tool, `recall`, that searches the message
history of the current thread in opencode's own SQLite database.

## Two rules that the design depends on

Never widen the search past the current thread. A thread is a session plus every subagent session
that it started, linked by `parent_id`. Do not add a flag, an option, or a fallback that reaches
other threads or the whole database. A match from unrelated work reads as authoritative and is
usually wrong. An empty result is the correct answer.

Never write into the prompt above the current turn. Results leave this plugin as a tool result and
nothing else. Do not register a hook that edits the system prompt or earlier messages. Text above
the current turn changes the cached prefix, and the provider then charges a full cache write. At
$6.25 per million cache-write tokens against $0.50 per million cached-read tokens, that turns a
$0.05 turn into a $0.60 turn.

## Constraints

- Open the database read-only. opencode holds it open in write-ahead log mode while it runs.
- Add no runtime dependency. `bun:sqlite` ships inside opencode, and the plugin API is the only
  import.
- Keep the result bounded. `maxChars` caps the whole response, and the tool sets
  `metadata.truncated` so that opencode does not truncate it a second time.
- Return no `output` key from the tool unless the tool also declares an `output` schema. opencode
  calls `Effect.die` on that combination (`packages/core/src/tool/runtime.ts:45-46`), so every call
  fails instead of returning an error. Put structured values in `metadata`.
- Target the v2 API only. A v2 plugin default-exports `Plugin.define({ id, setup })` and registers
  tools with `ctx.tool.transform`. The v1 hook object does not exist in this generation.

## Layout

| File | Contents |
| --- | --- |
| `src/index.ts` | Plugin entry, tool definition, options |
| `src/db.ts` | Database path resolution and the read-only handle |
| `src/scope.ts` | Thread resolution and the compaction checkpoint |
| `src/search.ts` | Match, rank, snippet, and render |
| `src/text.ts` | Message text for both message shapes |
| `test/` | Fixture database and tests |

## Message shapes

A user message holds its text in `data.text`. An assistant message holds an array in `data.content`.
Read the entries of type `text`. Skip the entries of type `reasoning`: they carry a large encrypted
blob that is useless to search.

## Before you commit

```sh
bun test
bun run typecheck
```

Add a test for every change to scope or ranking. The test that matters most asserts that a query
matching another thread returns nothing.

Verify a real change against live data as well. Open the database read-only, call `search` with a
session id from a thread, and make sure that every hit belongs to that thread.

## Prose

Comments explain a decision. The reader is new to this repository and knows what the project is for.
Put the history of the code in the commit message, not in a comment.
