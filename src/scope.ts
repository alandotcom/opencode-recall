import type { Database } from "bun:sqlite"

/**
 * A thread is a session tree, not a single session.
 *
 * opencode spawns a child session for every subagent, linked to its caller by
 * `parent_id`. Work on one task is therefore spread across a root session and
 * its descendants, so recall has to resolve the whole tree from whichever
 * session happens to be asking. The caller is usually a subagent, so we walk up
 * to the root before walking back down.
 */
export function threadSessions(db: Database, sessionID: string): string[] {
  const rows = db
    .query<{ id: string }, [string]>(
      `with recursive up(id, parent_id) as (
         select id, parent_id from session_v2 where id = ?
         union all
         select s.id, s.parent_id from session_v2 s join up on s.id = up.parent_id
       ),
       root as (select id from up where parent_id is null limit 1),
       thread(id) as (
         select id from root
         union all
         select s.id from session_v2 s join thread t on s.parent_id = t.id
       )
       select id from thread`,
    )
    .all(sessionID)
  // A session with no row of its own (or an orphan) still gets to search itself.
  return rows.length > 0 ? rows.map((r) => r.id) : [sessionID]
}

/**
 * The sequence number of a session's most recent compaction checkpoint.
 *
 * Everything below it has dropped out of the model's context even though it is
 * still on disk, which is exactly the material recall exists to reach. Returns
 * undefined when the session has never compacted.
 */
export function latestCheckpoint(db: Database, sessionID: string): number | undefined {
  const row = db
    .query<{ seq: number | null }, [string]>(
      `select max(seq) as seq from session_message where session_id = ? and type = 'compaction'`,
    )
    .get(sessionID)
  return row?.seq ?? undefined
}
