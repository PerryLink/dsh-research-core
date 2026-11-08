/**
 * Content addressing: hashes are the identity of every snapshot, so they are
 * pinned against known vectors and the derived helpers are pinned against each
 * other.
 * @module test/hash.spec
 */

import { describe, expect, it } from 'vitest'
import {
  HASH_REF_PATTERN,
  hashRefHex,
  isHashRef,
  objectPathOf,
  sha256Hex,
  sha256Json,
  snapshotIdOf,
  stableId,
} from '../src/hash.ts'

describe('sha256 helpers', () => {
  it('matches the published SHA-256 test vector', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('hashes bytes and their UTF-8 string identically', () => {
    expect(sha256Hex(Buffer.from('大', 'utf8'))).toBe(sha256Hex('大'))
  })

  it('builds content addresses and their store paths', () => {
    const id = snapshotIdOf('hello')
    expect(HASH_REF_PATTERN.test(id)).toBe(true)
    expect(id.startsWith('sha256:')).toBe(true)
    expect(hashRefHex(id)).toBe(sha256Hex('hello'))
    expect(objectPathOf(id)).toBe(`objects/${sha256Hex('hello')}`)
    expect(isHashRef(id)).toBe(true)
    expect(isHashRef('sha256:XYZ')).toBe(false)
  })

  it('rejects malformed addresses in hashRefHex', () => {
    expect(() => hashRefHex('md5:abc' as never)).toThrow(/not a REP content address/)
  })
})

describe('stableId', () => {
  it('is deterministic and content-addressed', () => {
    expect(stableId('ev', ['doi', '10.1/x'])).toBe(stableId('ev', ['doi', '10.1/x']))
    expect(stableId('ev', ['doi', '10.1/x'])).not.toBe(stableId('ev', ['doi', '10.1/y']))
    expect(stableId('cl', ['doi', '10.1/x'])).not.toBe(stableId('ev', ['doi', '10.1/x']))
    expect(stableId('ev', ['a'])).toMatch(/^ev-[a-f0-9]{12}$/u)
  })

  it('refuses prefixes that would produce an invalid REP id', () => {
    expect(() => stableId('EV', ['a'])).toThrow(/prefix/)
    expect(() => stableId('e v', ['a'])).toThrow(/prefix/)
  })
})

describe('sha256Json', () => {
  it('is insensitive to key order', () => {
    expect(sha256Json({ a: 1, b: [2, 3] })).toBe(sha256Json({ b: [2, 3], a: 1 }))
  })

  it('changes when the value changes', () => {
    expect(sha256Json({ a: 1 })).not.toBe(sha256Json({ a: 2 }))
  })
})
