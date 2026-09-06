# opencode-recall

An opencode v2 plugin. It adds one tool, `recall`, that searches earlier messages in the current
thread.

opencode compacts a long session. Compaction replaces older messages with a summary of 4,096 tokens
at most. The messages stay in the opencode database. They only stop reaching the model. `recall`
reads them back.

## Scope

A thread is one session plus every subagent session that it started. opencode links them with
`parent_id`. `recall` resolves that group from the session that called it, and searches only that
group.

`recall` never searches another thread. If nothing matches, it reports that nothing matched. An
answer taken from unrelated work is worse than no answer.

Search uses BM25 term relevance. Query terms do not need to be next to each other or in the same
order. Common English singular and plural forms, such as `plugin` and `plugins`, share a search
term. A short description with distinctive words or identifiers works best.

## If you want to search every thread

This plugin searches one thread on purpose. Other projects index every session you have, and they
are better at that job:

| Project | Reads |
| --- | --- |
| `singleflo/opencode-history-mcp` | opencode's database, through a separate full-text index |
| `nerdyaustin/memory_mcp` | opencode, Claude Code, Codex, and Gemini, plus a note store |
| `callimachus` | Eleven agents, with keyword and on-device semantic ranking |
| `code-session-memory` | opencode and five other tools, into one vector database |

Install one of those if you want to find work from another thread. Do not expect `recall` to grow
that ability. A match from unrelated work reads as authoritative and is usually wrong, which is the
reason this plugin stays narrow.

## Security

`recall` returns text that people wrote in earlier turns. Treat it as information, not as
instructions. If a hostile instruction was ever pasted into this thread, the model can read it again
later and try to follow it. The same is true of a secret: `recall` will show it again.

Reading one thread is a smaller risk than reading every session on disk, which is what a global
search tool gives a model. The risk is not zero. Do not give an agent that works on untrusted input
a tool that reads conversation history.

`recall` opens the database read-only and never writes to it.

## Install

Paste this into opencode:

```
Install the opencode-recall plugin.

1. Add "github:alandotcom/opencode-recall" to the "plugins" array in
   ~/.config/opencode/opencode.json, or the absolute path to the repository directory if I have it
   cloned. Create the "plugins" array if it does not exist. Do not change any other key.
2. Ask me which model the recall agent must use, then wait for my answer. List the models that the
   configuration already uses so that I can pick one. A cheap and fast model is the right choice,
   because this agent reads a lot of history and writes a short summary.
3. Write ~/.config/opencode/agents/recall.md with the model that I chose. Use the frontmatter and
   the body from the "Agent" section of the opencode-recall README.
4. Add the rule from the "Make the agent use it" section of that README to my global AGENTS.md.
5. Tell me to restart opencode, then show me what you changed.
```

To install by hand, add one entry to `plugins` in `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugins": ["github:alandotcom/opencode-recall"]
}
```

opencode reads a non-absolute entry with `npm-package-arg`, so a `github:owner/repo` entry installs
from git. Add `#<sha>` to pin a commit. An absolute entry must name the directory, not a file. A
relative entry resolves against the directory of the configuration file.

You can also skip the configuration file. opencode loads what it finds in
`~/.config/opencode/plugin/` and `~/.config/opencode/plugins/`, symbolic links included:

```sh
ln -s ~/projects/opencode-recall ~/.config/opencode/plugins/opencode-recall
```

## Options

Options go in the object form of the entry:

```jsonc
{
  "plugins": [{ "package": "github:alandotcom/opencode-recall", "options": { "limit": 10 } }]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `limit` | `10` | Largest number of matches for one call. |
| `snippetChars` | `400` | Characters of context around each match. |
| `maxChars` | `6000` | Largest size of the whole tool result. |
| `database` | resolved | Path to `opencode.db`. Read from `OPENCODE_DB`, else the data directory. |

## Agent

`recall` is an ordinary tool, so any agent can call it. A cheap subagent keeps the reading off the
context of your main model. Save this file as `~/.config/opencode/agents/recall.md` and set the
model to a cheap and fast one:

```md
---
description: Searches earlier messages in the current thread, including messages lost to compaction. Use it before you re-read files or decide something the thread already decided.
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

You search the history of this thread and report what it already established.

Call the `recall` tool with a short description of what you need. It ranks results with BM25, so use
distinctive words or identifiers and omit words that do not describe the subject. Try two or three
wordings before you decide that the thread holds nothing.

Answer in a few sentences. Quote the line that settles the question. Give its session and sequence
number so that the caller can read more. If nothing matches, say so. Never guess what the thread
decided, and never read project files. Your subject is the conversation, not the code.
```

## Make the agent use it

An agent does not search its own history unless you tell it to. Add this to your global
`AGENTS.md`:

```md
## Search this thread first

Delegate to the `recall` agent before you re-read files, and before you decide anything that this
thread already decided. Always do this on your first turn after a compaction. Ask what the thread
already established about the work in front of you. Explore the code directly only if `recall`
returns nothing.
```

## No prompt injection

`recall` returns its results as a tool result, at the end of the prompt. It never writes into the
system prompt or into earlier messages.

Text placed above the current turn changes the cached prefix, and the provider must then write the
whole prefix to cache again. For a context of 96,000 tokens, that rewrite costs $0.60 each turn at
$6.25 per million cache-write tokens. Reading the same prefix from cache costs $0.05 at $0.50 per
million tokens. Some memory plugins inject text on every turn. This one cannot.

## Development

```sh
bun install
bun test          # offline, against a fixture database
bun run typecheck
```

The plugin opens `opencode.db` read-only and never writes to it. `bun:sqlite` ships inside opencode,
so the only dependency is the plugin API.

This is a v2 plugin. It cannot load in opencode v1. The two plugin APIs share no surface. A v1 plugin
exports a factory that returns a hooks object. A v2 plugin default-exports `Plugin.define({ id,
setup })` and registers everything inside `setup`. If your configuration uses the `plugin` key
instead of `plugins`, you run v1, and this plugin will not load.

## License

MIT
