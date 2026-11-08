/**
 * REP event vocabulary.
 *
 * The names are part of the protocol: a plugin that emits them and a consumer
 * that subscribes to them never import each other. Session-log emission itself
 * is the emitting plugin's job (each plugin already injects `session`); core
 * only freezes the names and payload shapes so third parties can subscribe.
 *
 * @module @perrylink/dsh-research-core/events
 */

import type { HashRef, IsoTimestamp, RepId, Verdict } from './types.ts'

/** Event names shared across the research plugin family. */
export const RESEARCH_EVENTS = {
  /** A snapshot was captured and registered (content address ↔ capture). */
  evidenceCaptured: 'research/evidence.captured',
  /** A claim's verdict was written back. */
  claimVerified: 'research/claim.verified',
  /** A check produced a finding worth surfacing. */
  auditFinding: 'research/audit.finding',
  /** A report manifest was sealed. */
  reportSealed: 'research/report.sealed',
} as const

/** Payload of {@link RESEARCH_EVENTS.evidenceCaptured}. */
export interface EvidenceCapturedEvent {
  readonly evidenceId: RepId
  readonly snapshotId: HashRef
  readonly bytes: number
  readonly mediaType: string
  readonly origin: string
  readonly capturedAt: IsoTimestamp
  readonly deduplicated: boolean
}

/** Payload of {@link RESEARCH_EVENTS.claimVerified}. */
export interface ClaimVerifiedEvent {
  readonly claimId: RepId
  readonly verdict: Verdict
  readonly evidenceRefs: readonly RepId[]
  readonly checks: number
}

/** Payload of {@link RESEARCH_EVENTS.auditFinding}. */
export interface AuditFindingEvent {
  readonly checkId: RepId
  readonly check: string
  readonly status: 'pass' | 'fail' | 'warn' | 'skipped'
  readonly detail: string
  readonly severity: 'info' | 'warning' | 'error'
}

/** Payload of {@link RESEARCH_EVENTS.reportSealed}. */
export interface ReportSealedEvent {
  readonly recordId: RepId
  readonly manifestId: RepId
  readonly manifestHash: string
  readonly verdictCounts: Readonly<Record<Verdict, number>>
}
