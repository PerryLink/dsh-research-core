/**
 * Content addressing and stable identifiers.
 *
 * Every REP hash is SHA-256 over UTF-8 bytes (strings) or the raw bytes
 * (Uint8Array) — never over a re-serialized object. `stableId` derives ids from
 * canonical JSON so the same inputs always produce the same id.
 *
 * @module @perrylink/dsh-research-core/hash
 */

import { createHash } from 'node:crypto'
import { canonicalJson } from './canonical.ts'
import type { HashRef, RepId, Sha256Hex } from './types.ts'

/** `sha256:<64 lowercase hex>`. */
export const HASH_REF_PATTERN = /^sha256:[a-f0-9]{64}$/u

/**
 * SHA-256 of a string (UTF-8) or raw bytes.
 * @param input - text or bytes.
 * @returns the lowercase hex digest.
 */
export function sha256Hex(input: string | Uint8Array): Sha256Hex {
  const hash = createHash('sha256')
  hash.update(typeof input === 'string' ? Buffer.from(input, 'utf8') : input)
  return hash.digest('hex')
}

/**
 * The content address of a snapshot: `sha256:<hex>` over the exact bytes.
 * @param input - snapshot bytes or text.
 * @returns the self-describing content address.
 */
export function snapshotIdOf(input: string | Uint8Array): HashRef {
  return `sha256:${sha256Hex(input)}`
}

/**
 * Extract the hex digest from a content address.
 * @param ref - a `sha256:<hex>` address.
 * @returns the 64-character hex digest.
 * @throws TypeError when the address is malformed.
 */
export function hashRefHex(ref: HashRef): Sha256Hex {
  if (!HASH_REF_PATTERN.test(ref)) {
    throw new TypeError(`not a REP content address: ${String(ref)}`)
  }
  return ref.slice('sha256:'.length)
}

/**
 * Build the canonical store path for a snapshot: `objects/<hex>`.
 * @param ref - the snapshot content address.
 * @returns the relative store path.
 */
export function objectPathOf(ref: HashRef): string {
  return `objects/${hashRefHex(ref)}`
}

/**
 * True when the value is a well-formed `sha256:<hex>` content address.
 * @param value - the value to test.
 * @returns whether it is a content address.
 */
export function isHashRef(value: unknown): value is HashRef {
  return typeof value === 'string' && HASH_REF_PATTERN.test(value)
}

/**
 * Hash arbitrary JSON deterministically (canonical JSON → UTF-8 → SHA-256).
 * @param value - any JSON-compatible value.
 * @returns the lowercase hex digest.
 */
export function sha256Json(value: unknown): Sha256Hex {
  return sha256Hex(canonicalJson(value))
}

const STABLE_ID_PREFIX = /^[a-z][a-z0-9]*$/u

/**
 * Derive a stable, collision-resistant id from a prefix and any JSON parts.
 * @param prefix - short lowercase namespace, e.g. `ev`, `cl`, `chk`.
 * @param parts - values that fully determine the id.
 * @returns `<prefix>-<12 hex chars>`.
 */
export function stableId(prefix: string, ...parts: readonly unknown[]): RepId {
  if (!STABLE_ID_PREFIX.test(prefix)) {
    throw new TypeError(`stableId prefix must match ${STABLE_ID_PREFIX.source}, got ${String(prefix)}`)
  }
  return `${prefix}-${sha256Json(parts).slice(0, 12)}`
}

/**
 * Content hash of a claim text, used by manifest claim entries.
 * @param text - the claim text.
 * @returns the lowercase hex digest.
 */
export function claimTextHash(text: string): Sha256Hex {
  return sha256Hex(text)
}
