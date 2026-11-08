/**
 * Config schema and resolution for `@perrylink/dsh-research-core`.
 *
 * Every tunable is a validated {@link Config} field changeable from
 * cordis.yml; {@link resolveConfig} validates the bounds so a misconfigured
 * profile fails loud at mount instead of silently writing somewhere unexpected.
 *
 * @module @perrylink/dsh-research-core/config
 */

import path from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Raw plugin config — every field optional. */
export interface Config {
  /** Master switch. `false` mounts no service at all. */
  enabled?: boolean
  /**
   * REP store root (objects + JSONL journals + sealed records). Relative paths
   * resolve against the harness working directory, keeping data in the
   * workspace by default.
   */
  root?: string
  /** Hard cap on one snapshot's byte size. */
  maxSnapshotBytes?: number
  /** Hard cap on registered evidence items. */
  maxEvidence?: number
  /** Hard cap on registered claims. */
  maxClaims?: number
}

/** Fully resolved config; `root` is absolute. */
export interface ResolvedConfig {
  readonly enabled: boolean
  readonly root: string
  readonly maxSnapshotBytes: number
  readonly maxEvidence: number
  readonly maxClaims: number
}

/** Schemastery schema: the loader validates and fills defaults before `apply`. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  root: z.string().default('.research-rep'),
  maxSnapshotBytes: z.number().default(20 * 1024 * 1024),
  maxEvidence: z.number().default(10_000),
  maxClaims: z.number().default(10_000),
})

/** Throw unless `value` is a positive safe integer. */
function assertPositiveInt(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer, got ${String(value)}`)
  }
}

/**
 * Validate raw values and fill explicit defaults.
 * @param config - raw (possibly partial) plugin config.
 * @returns the fully resolved config.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const root = config.root ?? '.research-rep'
  if (typeof root !== 'string' || root.trim() === '') {
    throw new TypeError('root must be a non-empty path')
  }
  const maxSnapshotBytes = config.maxSnapshotBytes ?? 20 * 1024 * 1024
  assertPositiveInt('maxSnapshotBytes', maxSnapshotBytes)
  const maxEvidence = config.maxEvidence ?? 10_000
  assertPositiveInt('maxEvidence', maxEvidence)
  const maxClaims = config.maxClaims ?? 10_000
  assertPositiveInt('maxClaims', maxClaims)
  return {
    enabled: config.enabled ?? true,
    root: path.resolve(root),
    maxSnapshotBytes,
    maxEvidence,
    maxClaims,
  }
}
