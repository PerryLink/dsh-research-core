/**
 * Audit chain: append-only and tamper-evident, including reordering.
 * @module test/audit.spec
 */

import { describe, expect, it } from 'vitest'
import { auditEventHash, createAuditEvent, verifyAuditChain } from '../src/audit.ts'
import type { AuditEvent } from '../src/types.ts'

const clock = (): Date => new Date('2026-01-15T10:00:00.000Z')

/** Build a short, valid chain. */
function chain(): AuditEvent[] {
  const first = createAuditEvent({ eventId: 'evt-1', actor: 'plugin', type: 'snapshot.captured', payload: { n: 1 } }, clock)
  const second = createAuditEvent(
    { eventId: 'evt-2', actor: 'plugin', type: 'evidence.registered', payload: { n: 2 }, prevHash: first.hash },
    clock,
  )
  const third = createAuditEvent({ eventId: 'evt-3', actor: 'human', type: 'claim.verdict', payload: { n: 3 }, prevHash: second.hash }, clock)
  return [first, second, third]
}

describe('audit chain', () => {
  it('accepts an intact chain', () => {
    expect(verifyAuditChain(chain())).toEqual([])
  })

  it('detects an edited payload', () => {
    const events = chain()
    const tampered = { ...events[1]!, payload: { n: 999 } }
    const issues = verifyAuditChain([events[0]!, tampered, events[2]!])
    expect(issues.map(issue => issue.code)).toContain('event.hash_mismatch')
    // A sophisticated editor that also recomputes the event hash breaks the
    // link instead — both paths are covered.
    const recomputed = { ...tampered, hash: auditEventHash(tampered) }
    expect(verifyAuditChain([events[0]!, recomputed, events[2]!]).map(issue => issue.code)).toContain('event.prev_mismatch')
  })

  it('detects reordering', () => {
    const events = chain()
    const issues = verifyAuditChain([events[0]!, events[2]!, events[1]!])
    expect(issues.map(issue => issue.code)).toContain('event.prev_mismatch')
  })

  it('rejects a first event that carries a prevHash', () => {
    const events = chain()
    const issues = verifyAuditChain([{ ...events[0]!, prevHash: 'f'.repeat(64) }])
    expect(issues.map(issue => issue.code)).toContain('event.unexpected_prev')
  })

  it('detects duplicate event ids', () => {
    const events = chain()
    const issues = verifyAuditChain([events[0]!, { ...events[0]!, prevHash: events[0]!.hash }])
    expect(issues.map(issue => issue.code)).toContain('event.duplicate_id')
  })

  it('leaves out optional prevHash from the hash input deterministically', () => {
    const body = { eventId: 'evt-x', at: '2026-01-15T10:00:00.000Z', actor: 'system' as const, type: 'a.b', payload: { k: 'v' } }
    expect(auditEventHash(body)).toBe(auditEventHash({ ...body }))
    expect(auditEventHash(body)).not.toBe(auditEventHash({ ...body, prevHash: 'a'.repeat(64) }))
  })
})
