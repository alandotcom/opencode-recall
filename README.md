# opencode-recall

An opencode v2 plugin. It adds one tool, `recall`, that searches earlier messages in the
**current thread**, including the messages that dropped out of context when the session compacted.

opencode's compaction replaces older context with a summary capped at 4,096 output tokens. The
messages themselves are never deleted, they just stop being loaded. `recall` reads them back out of
opencode's own database.

## The scope rule

A thread is a session tree: a root session plus every subagent session it spawned, linked by
`parent_id`. `recall` resolves that tree from whichever session calls it and searches only there.

It never widens. A query that matches nothing returns "no matches in this thread" rather than falling
back to other threads or to every session on disk. A confident answer pulled from unrelated work is
worse than no answer.

## Install

Paste this into opencode:

```
Install the opencode-recall plugin.

1. Add it to the "plugins" array in ~/.config/opencode/opencode.json. Use the local path if the repo
   is cloned (for example "/Users/me/projects/opencode-recall"), otherwise the package name.
   Create the "plugins" array if it does not exist. Do not disturb the other keys.
2. Ask me which model the recall agent should use, and wait for my answer. Show me the models I
   already use in that config so I can pick one. A cheap, fast model is the right choice: this agent
   reads a lot of history and writes a short summary.
3. Write ~/.config/opencode/agents/recall.md using the model I chose, with the frontmatter and body
   from the "Agent" section of the opencode-recall README.
4. Append the rule from the "Make it get used" section of that README to my global AGENTS.md.
5. Tell me to restart opencode, then show me what you changed.
```

Or do it by hand: add the plugin to `plugins`, then copy the agent file below.

```jsonc
{
  "plugins": ["opencode-recall"]
}
```

Options are optional, and go in the object form:

```jsonc
{
  "plugins": [{ "package": "opencode-recall", "options": { "limit": 10, "maxChars": 6000 } }]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `limit` | `10` | Maximum matches returned per call. |
| `snippetChars` | `400` | Characters of context shown around each match. |
| `maxChars` | `6000` | Hard cap on the whole tool result. |
| `database` | resolved | Path to `opencode.db`. Resolved from `OPENCODE_DB`, else the data directory. |

## Agent

`recall` is a plain tool, so any agent can call it. Running it in a cheap subagent keeps the reading
off your main model's context. Save this as `~/.config/opencode/agents/recall.md` and set the model
to whichever cheap, fast model you use.

```md
---
description: Searches earlier messages in the current thread, including anything lost to compaction. Use before re-reading files or re-deriving a decision the thread may already have settled.
mode: subagent
model: <your-provider>/<your-cheap-model>
permissions:
  - action: edit
    resource: "*"
    effect: deny
  - action: subagent
    resource: "*"
    effect: deny
---

You search this thread's own history and report what it already established.

Call the `recall` tool with a distinctive word or identifier. Matching is literal substring, so
prefer `flexbox` or `useViewport` over a whole sentence. Try two or three phrasings before concluding
nothing is there.

Answer in a few sentences. Quote the line that settles the question and cite its session and sequence
number so the caller can read more. If nothing matches, say so plainly. Never guess at what the
thread probably decided, and never read project files: your job is the conversation, not the code.
```

## Make it get used

Agents do not reach for history on their own. Add this to your global `AGENTS.md`:

```md
## Check this thread's history first

Before re-reading files or re-deriving a decision on a task this thread has already touched, and
always on your first turn after a compaction, delegate to the `recall` agent. Ask it what this thread
already established about the thing you are about to work on. Only explore the codebase directly if
recall comes back empty.
```

## Why it does not inject anything

Everything `recall` returns arrives as an ordinary tool result, at the end of the prompt. Nothing is
written into the system prompt or into earlier turns.

That is deliberate. Retrieved text placed above the current turn changes the cached prompt prefix,
which forces the provider to write the whole prefix to cache again. On a 96k-token context billed at
$6.25 per million cache-write tokens against $0.50 per million cached-read tokens, that is $0.60 a
turn instead of $0.05. Several memory plugins inject on every turn. This one cannot, by design.

## Development

```sh
bun install
bun test          # offline, against a fixture database
bun run typecheck
```

The plugin opens `opencode.db` read-only and never writes to it. `bun:sqlite` ships inside opencode,
so there are no runtime dependencies.

## License

MIT
