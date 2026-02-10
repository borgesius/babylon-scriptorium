import createDebug from "debug"

const APP_PREFIX = "app"

/**
 * Create a namespaced logger instance.
 * All loggers are prefixed with the APP_PREFIX for easy filtering.
 *
 * @param namespace - The subsystem name (e.g., "api", "db")
 * @returns A debug logger function
 */
export function createLogger(namespace: string): createDebug.Debugger {
    return createDebug(`${APP_PREFIX}:${namespace}`)
}

/**
 * Pre-defined loggers for common systems.
 *
 * Usage:
 * ```typescript
 * import { log } from "./core/Logger.js"
 * log.api("Fetching data from %s", endpoint)
 * log.db("Query executed: %o", { table, rows })
 * ```
 *
 * Enable via env: `DEBUG=app:*`
 * Enable specific: `DEBUG=app:api,app:db`
 */
export const log = {
    api: createLogger("api"),
    db: createLogger("db"),
    app: createLogger("app"),
}
