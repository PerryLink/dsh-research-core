/**
 * Canonical JSON for REP hashing.
 *
 * Object keys are sorted by UTF-16 code unit (the RFC 8785 ordering), numbers
 * are serialized with ECMAScript `Number::toString` (again RFC 8785), strings
 * use standard JSON escaping, and `undefined` object properties are omitted.
 * This is the byte sequence every REP hash is computed over, so it must stay
 * stable forever for a given value.
 *
 * @module @perrylink/dsh-research-core/canonical
 */

/** Thrown when a value cannot be canonicalized (cycle, non-finite number, lone surrogate…). */
export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CanonicalJsonError'
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u

/**
 * Serialize one string exactly as canonical JSON does.
 * @param value - the string to serialize.
 * @returns the quoted, escaped JSON string.
 */
function canonicalString(value: string): string {
  if (LONE_SURROGATE.test(value)) {
    throw new CanonicalJsonError('strings must be well-formed Unicode (lone surrogates are not canonicalizable)')
  }
  return JSON.stringify(value)
}

/**
 * Serialize one number as canonical JSON does.
 * @param value - the number to serialize.
 * @returns the ECMAScript number-to-string form.
 */
function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalJsonError(`non-finite numbers are not canonicalizable: ${String(value)}`)
  }
  // JSON.stringify(-0) === "0"; RFC 8785 requires the same normalization.
  return JSON.stringify(value)
}

/**
 * Canonicalize any JSON-compatible value into its deterministic byte form.
 * @param value - the value to canonicalize.
 * @returns the canonical JSON text.
 */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>()
  const walk = (node: unknown): string => {
    if (node === null) return 'null'
    switch (typeof node) {
      case 'boolean':
        return node ? 'true' : 'false'
      case 'number':
        return canonicalNumber(node)
      case 'string':
        return canonicalString(node)
      case 'bigint':
        throw new CanonicalJsonError('bigint is not JSON-serializable')
      case 'function':
      case 'symbol':
      case 'undefined':
        throw new CanonicalJsonError(`${typeof node} is not JSON-serializable`)
      case 'object':
        break
    }
    const object = node as object
    if (seen.has(object)) throw new CanonicalJsonError('cyclic structure is not canonicalizable')
    seen.add(object)
    try {
      if (Array.isArray(object)) {
        const items: string[] = []
        for (const item of object) {
          if (item === undefined) throw new CanonicalJsonError('sparse arrays are not canonicalizable')
          items.push(walk(item))
        }
        return `[${items.join(',')}]`
      }
      const record = object as Record<string, unknown>
      // `Object.keys` on a class instance misses prototype state; REP values are
      // plain JSON data by contract, so own enumerable keys are the right set.
      const keys = Object.keys(record).filter(key => record[key] !== undefined)
      keys.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      const members: string[] = []
      for (const key of keys) {
        members.push(`${canonicalString(key)}:${walk(record[key])}`)
      }
      return `{${members.join(',')}}`
    } finally {
      seen.delete(object)
    }
  }
  return walk(value)
}

/**
 * Deep-clone a JSON value through canonicalization, dropping `undefined`
 * properties. Useful when a caller wants a normalized copy to hash later.
 * @param value - the value to normalize.
 * @returns the normalized clone.
 */
export function normalizeJson<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T
}
