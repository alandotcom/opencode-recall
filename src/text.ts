/**
 * A row from opencode's `session_message` table, with `data` already parsed.
 *
 * The two message types store their text differently, which is the only
 * awkward part of reading this table.
 */
export type MessageRow = {
  sessionID: string
  seq: number
  type: string
  createdAt: number
  data: unknown
}

/**
 * Pulls readable prose out of a message.
 *
 * User messages carry `text` directly. Assistant messages carry a `content`
 * array whose `text` entries hold prose; its `reasoning` entries hold large
 * encrypted blobs that are useless to search and expensive to scan, so they are
 * skipped.
 */
export function messageText(type: string, data: unknown): string {
  if (!data || typeof data !== "object") return ""
  const record = data as Record<string, unknown>

  if (type === "user") {
    return typeof record.text === "string" ? record.text : ""
  }

  const content = record.content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const item of content) {
    if (!item || typeof item !== "object") continue
    const part = item as Record<string, unknown>
    if (part.type !== "text") continue
    if (typeof part.text === "string" && part.text.length > 0) parts.push(part.text)
  }
  return parts.join("\n")
}
