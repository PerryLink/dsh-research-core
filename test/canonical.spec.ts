/**
 * Canonical JSON: determinism is the whole point, so every property that could
 * make two equal values serialize differently is pinned here.
 * @module test/canonical.spec
 */

import { describe, expect, it } from 'vitest'
import { CanonicalJsonError, canonicalJson, normalizeJson } from '../src/canonical.ts'

describe('canonicalJson', () => {
  it('sorts object keys by code unit regardless of insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}')
    expect(canonicalJson({ B: 1, a: 2, A: 3 })).toBe('{"A":3,"B":1,"a":2}')
  })

  it('recurses into objects and arrays', () => {
    expect(canonicalJson([{ z: 1, a: [3, { y: 2, b: 1 }] }])).toBe('[{"a":[3,{"b":1,"y":2}],"z":1}]')
  })

  it('omits undefined object properties but rejects sparse arrays', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
    expect(() => canonicalJson([1, undefined])).toThrow(CanonicalJsonError)
  })

  it('normalizes -0 to 0', () => {
    expect(canonicalJson(-0)).toBe('0')
  })

  it('rejects values that have no canonical form', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite/)
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(/non-finite/)
    expect(() => canonicalJson(1n)).toThrow(/bigint/)
    expect(() => canonicalJson(() => 1)).toThrow(/function/)
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    expect(() => canonicalJson(cyclic)).toThrow(/cyclic/)
  })

  it('rejects lone surrogates but accepts well-formed unicode', () => {
    expect(() => canonicalJson('\uD800')).toThrow(/well-formed Unicode/)
    expect(canonicalJson('héllo大')).toBe('"héllo大"')
  })

  it('is stable for equal values built in different orders', () => {
    const left = { schemaVersion: 1, recordId: 'rec-a', snapshots: [], evidence: [], claims: [] }
    const right = { claims: [], evidence: [], snapshots: [], recordId: 'rec-a', schemaVersion: 1 }
    expect(canonicalJson(left)).toBe(canonicalJson(right))
  })

  it('normalizeJson round-trips through JSON and drops undefined', () => {
    const value = normalizeJson({ a: 1, b: undefined as number | undefined })
    expect(value).toEqual({ a: 1 })
    expect('b' in value).toBe(false)
  })
})
