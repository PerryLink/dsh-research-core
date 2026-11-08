/**
 * Hash-chained audit events.
 *
 * Each event hashes its own canonical JSON plus the previous event's hash, so
 * removing, reordering or editing an event breaks the chain and is detected by
 * {@link verifyAuditChain}. The chain is append-only: callers never rewrite a
 * stored event.
 *
 * @module @perrylink/dsh-research-core/audit
 */

import { sha256Json, stableId } from './hash.ts'
import type { AuditEvent, IsoTimestamp, RepId, Sha256Hex } from './types.ts'

/** One audit event before its hash is computed. */
export interface AuditEventInput {
  /** Stable id; derived from the event content when omitted. */
  readonly eventId?: RepId
  /** ISO-8601 time; defaults to the caller's clock. */
  readonly at?: IsoTimestamp
  /** Who caused the event. */
  readonly actor: AuditEvent['actor']
  /** Namespaced event type, e.g. `evidence.captured`. */
  readonly type: string
  /** Event data. MUST NOT contain tokens, credentials or personal data. */
  readonly payload: Record<string, unknown>
  /** Previous event hash, when this event extends a chain. */
  readonly prevHash?: Sha256Hex
}

/** The hashed payload of an event. */
type AuditHashSubject = Omit<AuditEvent, 'hash'>

/**
 * Compute the audit hash over every event field except `hash` itself.
 * @param event - the event body.
 * @returns the lowercase hex digest.
 */
export function auditEventHash(event: AuditHashSubject): Sha256Hex {
  return sha256Json({
    eventId: event.eventId,
    at: event.at,
    actor: event.actor,
    type: event.type,
    payload: event.payload,
    ...(event.prevHash === undefined ? {} : { prevHash: event.prevHash }),
  })
}

/**
 * Build one hashed audit event.
 * @param input - the event body.
 * @param now - clock override (tests).
 * @returns the event including its hash.
 */
export function createAuditEvent(input: AuditEventInput, now: () => Date = () => new Date()): AuditEvent {
  const at = input.at ?? now().toISOString()
  const body: AuditHashSubject = {
    eventId: input.eventId ?? stableId('evt', [input.type, at, input.payload]),
    at,
    actor: input.actor,
    type: input.type,
    payload: input.payload,
    ...(input.prevHash === undefined ? {} : { prevHash: input.prevHash }),
  }
  return { ...body, hash: auditEventHash(body) }
}

/** One audit-chain defect. */
export interface AuditChainIssue {
  /** Zero-based index of the offending event. */
  readonly index: number
  /** Stable issue code. */
  readonly code: 'event.hash_mismatch' | 'event.prev_mismatch' | 'event.unexpected_prev' | 'event.duplicate_id'
  /** Human-readable explanation. */
  readonly message: string
}

/**
 * Recompute every event hash and the link to its predecessor.
 * @param events - the chain in append order.
 * @returns every defect found (empty means the chain is intact).
 */
export function verifyAuditChain(events: readonly AuditEvent[]): AuditChainIssue[] {
  const issues: AuditChainIssue[] = []
  const seen = new Set<string>()
  let previous: AuditEvent | undefined
  for (const [index, event] of events.entries()) {
    const expected = auditEventHash(event)
    if (expected !== event.hash) {
      issues.push({
        index,
        code: 'event.hash_mismatch',
        message: `event ${event.eventId} hash mismatch: recorded ${event.hash}, recomputed ${expected}`,
      })
    }
    if (seen.has(event.eventId)) {
      issues.push({ index, code: 'event.duplicate_id', message: `duplicate audit event id ${event.eventId}` })
    }
    seen.add(event.eventId)
    if (previous === undefined) {
      if (event.prevHash !== undefined) {
        issues.push({
          index,
          code: 'event.unexpected_prev',
          message: `first event ${event.eventId} must not carry prevHash`,
        })
      }
    } else if (event.prevHash !== previous.hash) {
      issues.push({
        index,
        code: 'event.prev_mismatch',
        message: `event ${event.eventId} prevHash does not match the preceding event hash`,
      })
    }
    previous = event
  }
  return issues
}
