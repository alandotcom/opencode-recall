import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

/**
 * Resolves the opencode database the same way opencode itself does.
 *
 * OPENCODE_DB wins when set: an absolute path is used as-is, a bare filename is
 * joined to the data directory. Otherwise the release channels (latest, beta,
 * prod) all share `opencode.db`, and any other channel gets its own file. We
 * cannot see the channel from inside a plugin, so we fall back to the shared
 * name and let OPENCODE_DB cover the unusual case.
 */
export function resolveDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  const dataDir = join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode")
  const override = env.OPENCODE_DB
  if (override) return isAbsolute(override) ? override : join(dataDir, override)
  return join(dataDir, "opencode.db")
}

/**
 * opencode holds this database open in WAL mode while it runs, so we only ever
 * open it read-only. A reader never blocks opencode's writer.
 */
export function openDatabase(path = resolveDatabasePath()): Database {
  return new Database(path, { readonly: true })
}
