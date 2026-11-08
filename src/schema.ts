/**
 * Access to the published JSON Schema.
 *
 * The schema file is shipped next to `lib/` (see `files` in package.json), so it
 * resolves identically from `src/` during tests and from `lib/` after a build.
 * It is read lazily: importing this package never touches the filesystem.
 *
 * @module @perrylink/dsh-research-core/schema
 */

import { readFileSync } from 'node:fs'

/** The `$id` of the published REP v1 schema. */
export const REP_SCHEMA_ID =
  'https://raw.githubusercontent.com/PerryLink/dsh-research-core/main/schema/rep-v1.schema.json'

/** The schema version described by {@link getRepSchema}. */
export const REP_SCHEMA_VERSION = 1

const SCHEMA_FILE = new URL('../schema/rep-v1.schema.json', import.meta.url)
let cached: Record<string, unknown> | undefined

/**
 * Load the REP v1 JSON Schema (cached after the first read).
 * @returns a deep copy safe for consumers to mutate.
 */
export function getRepSchema(): Record<string, unknown> {
  if (cached === undefined) {
    const text = readFileSync(SCHEMA_FILE, 'utf8')
    cached = JSON.parse(text) as Record<string, unknown>
  }
  return structuredClone(cached)
}
