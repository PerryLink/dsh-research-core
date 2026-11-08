/**
 * REP v1 invariant validation.
 *
 * `validateRep` answers: "is this record internally consistent?" It checks
 * cross-references, content addressing, verdict legality, the audit chain and
 * the manifest seal. It also performs a defensive structural pre-pass, but the
 * JSON Schema (`schema/rep-v1.schema.json`) remains the authority on shape.
 *
 * Every issue carries a stable `code` so CI gates and downstream plugins can
 * depend on it.
 *
 * @module @perrylink/dsh-research-core/validate
 */

import { verifyAuditChain } from './audit.ts'
import { claimInvariantViolations } from './claim.ts'
import { sha256Hex } from './hash.ts'
import { evidenceStatusOf, manifestHashOf, summarizeRecord, verifyManifestSeal } from './manifest.ts'
import type { Anchor, Artifact, AuditEvent, Claim, Evidence, ResearchRecord, Snapshot } from './types.ts'

/** One invariant violation or warning. */
export interface ValidationIssue {
  /** Stable, machine-readable code (see README "Issue codes"). */
  readonly code: string
  /** JSON-pointer-ish location inside the record, e.g. `/evidence/2`. */
  readonly path: string
  /** Human-readable explanation. */
  readonly message: string
  /** `error` fails validation; `warning` does not. */
  readonly severity: 'error' | 'warning'
}

/** The result of validating one record. */
export interface RepValidationResult {
  /** True when no issue has severity `error`. */
  readonly ok: boolean
  /** Every issue found, in traversal order. */
  readonly issues: readonly ValidationIssue[]
}

/** Accumulates issues and exposes a fail-fast-free API. */
class Issues {
  readonly list: ValidationIssue[] = []

  error(code: string, path: string, message: string): void {
    this.list.push({ code, path, message, severity: 'error' })
  }

  warn(code: string, path: string, message: string): void {
    this.list.push({ code, path, message, severity: 'warning' })
  }
}

/** True for a plain non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read an array field, reporting a type issue when present but not an array. */
function arrayField(value: unknown, path: string, issues: Issues, required: boolean): unknown[] | undefined {
  if (value === undefined) {
    if (required) issues.error('record.field_type', path, 'required array is missing')
    return undefined
  }
  if (!Array.isArray(value)) {
    issues.error('record.field_type', path, 'expected an array')
    return undefined
  }
  return value
}

const HASH_REF = /^sha256:[a-f0-9]{64}$/u
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

/** Validate the kind-specific shape of one anchor. */
function anchorShapeProblem(anchor: Record<string, unknown>): string | undefined {
  const kind = anchor['kind']
  const value = anchor['value']
  if (typeof kind !== 'string') return 'anchor.kind must be a string'
  if (typeof value !== 'string' || value === '') return 'anchor.value must be a non-empty string'
  switch (kind) {
    case 'page':
      if (typeof anchor['page'] !== 'number') return 'page anchors require a numeric `page`'
      if (!/^p\.[0-9]{1,6}$/u.test(value)) return 'page anchors require value `p.<n>`'
      return undefined
    case 'char': {
      const range = anchor['charRange']
      if (!isRecord(range) || typeof range['start'] !== 'number' || typeof range['end'] !== 'number') {
        return 'char anchors require a numeric `charRange`'
      }
      if (!/^c\.[0-9]+-[0-9]+$/u.test(value)) return 'char anchors require value `c.<start>-<end>`'
      if (range['end'] <= range['start']) return 'charRange.end must be greater than charRange.start'
      return undefined
    }
    case 'paragraph':
      if (typeof anchor['paragraph'] !== 'number') return 'paragraph anchors require a numeric `paragraph`'
      if (!/^para\.[0-9]+$/u.test(value)) return 'paragraph anchors require value `para.<n>`'
      return undefined
    case 'table':
      if (typeof anchor['ordinal'] !== 'number') return 'table anchors require a numeric `ordinal`'
      if (!/^t\.[0-9]+$/u.test(value)) return 'table anchors require value `t.<n>`'
      return undefined
    case 'figure':
      if (typeof anchor['ordinal'] !== 'number') return 'figure anchors require a numeric `ordinal`'
      if (!/^f\.[0-9]+$/u.test(value)) return 'figure anchors require value `f.<n>`'
      return undefined
    case 'record':
      if (!/^field:[A-Za-z0-9_.-]{1,200}$/u.test(value)) return 'record anchors require value `field:<name>`'
      return undefined
    case 'section':
      return undefined
    default:
      return `unknown anchor kind ${kind}`
  }
}

/** Validate the shared shape of every anchor in a list. */
function checkAnchors(
  rawAnchors: readonly unknown[],
  path: string,
  issues: Issues,
  snapshotIds: ReadonlySet<string>,
  restrictTo?: ReadonlySet<string>,
): void {
  for (const [index, raw] of rawAnchors.entries()) {
    const at = `${path}/${index}`
    if (!isRecord(raw)) {
      issues.error('anchor.shape', at, 'anchor must be an object')
      continue
    }
    const problem = anchorShapeProblem(raw)
    if (problem !== undefined) issues.error('anchor.shape', at, problem)
    const snapshotId = raw['snapshotId']
    if (typeof snapshotId !== 'string' || !HASH_REF.test(snapshotId)) {
      issues.error('anchor.snapshot_id', at, 'anchor.snapshotId must be a `sha256:<hex>` content address')
    } else {
      if (!snapshotIds.has(snapshotId)) {
        issues.error('anchor.snapshot_unknown', at, `anchor refers to an unknown snapshot ${snapshotId}`)
      }
      if (restrictTo !== undefined && !restrictTo.has(snapshotId)) {
        issues.error('anchor.snapshot_outside_evidence', at, 'anchor refers to a snapshot the evidence does not bind')
      }
    }
    const quote = raw['quote']
    const quoteHash = raw['quoteHash']
    if (quoteHash !== undefined) {
      if (typeof quoteHash !== 'string' || !/^[a-f0-9]{64}$/u.test(quoteHash)) {
        issues.error('anchor.quote_hash', at, 'anchor.quoteHash must be a lowercase hex SHA-256')
      } else if (typeof quote === 'string' && sha256Hex(quote) !== quoteHash) {
        issues.error('anchor.quote_hash_mismatch', at, 'anchor.quoteHash does not match sha256(anchor.quote)')
      } else if (quote === undefined) {
        issues.error('anchor.quote_hash', at, 'anchor.quoteHash requires anchor.quote')
      }
    }
  }
}

/** Check that a `not_found` code is always paired with `skipped`. */
function checkCodes(rawChecks: readonly unknown[], path: string, issues: Issues): void {
  for (const [index, raw] of rawChecks.entries()) {
    if (!isRecord(raw)) {
      issues.error('check.shape', `${path}/${index}`, 'check must be an object')
      continue
    }
    if (raw['code'] === 'not_found' && raw['status'] !== 'skipped') {
      issues.error(
        'check.not_found_status',
        `${path}/${index}`,
        'code `not_found` means "could not locate": it must be recorded as `skipped`, never as pass/fail',
      )
    }
    if (typeof raw['detail'] !== 'string' || raw['detail'] === '') {
      issues.error('check.detail', `${path}/${index}`, 'check.detail must be a non-empty string')
    }
  }
}

/** Collect duplicate ids and report them. */
function checkIds(values: readonly unknown[], path: string, issues: Issues): Set<string> {
  const seen = new Set<string>()
  for (const [index, value] of values.entries()) {
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
      issues.error('id.invalid', `${path}/${index}`, `invalid id ${JSON.stringify(value)}`)
      continue
    }
    if (seen.has(value)) issues.error('id.duplicate', `${path}/${index}`, `duplicate id ${value}`)
    seen.add(value)
  }
  return seen
}

/**
 * Validate one REP v1 record against every cross-reference and verdict
 * invariant.
 * @param value - the parsed record (unknown input is handled defensively).
 * @returns the validation result.
 */
export function validateRep(value: unknown): RepValidationResult {
  const issues = new Issues()
  if (!isRecord(value)) {
    issues.error('record.not_object', '', 'a REP record must be a JSON object')
    return { ok: false, issues: issues.list }
  }
  if (value['schemaVersion'] !== 1) {
    issues.error('record.schema_version', '/schemaVersion', 'schemaVersion must be 1')
  }
  if (typeof value['recordId'] !== 'string' || !ID_PATTERN.test(value['recordId'])) {
    issues.error('id.invalid', '/recordId', 'recordId must match the REP id pattern')
  }

  const rawSnapshots = arrayField(value['snapshots'], '/snapshots', issues, true) ?? []
  const rawEvidence = arrayField(value['evidence'], '/evidence', issues, true) ?? []
  const rawClaims = arrayField(value['claims'], '/claims', issues, true) ?? []
  const rawArtifacts = arrayField(value['artifacts'], '/artifacts', issues, false) ?? []
  const rawAudit = arrayField(value['audit'], '/audit', issues, false) ?? []

  // ── snapshots ────────────────────────────────────────────────────────────
  const snapshotIds = checkIds(
    rawSnapshots.map(raw => (isRecord(raw) ? raw['snapshotId'] : undefined)),
    '/snapshots',
    issues,
  )
  for (const [index, raw] of rawSnapshots.entries()) {
    const at = `/snapshots/${index}`
    if (!isRecord(raw)) {
      issues.error('snapshot.shape', at, 'snapshot must be an object')
      continue
    }
    const snapshotId = raw['snapshotId']
    const path = raw['path']
    if (typeof snapshotId === 'string' && HASH_REF.test(snapshotId)) {
      const expected = `objects/${snapshotId.slice('sha256:'.length)}`
      if (path !== expected) {
        issues.error('snapshot.path_mismatch', at, `snapshot.path must be "${expected}" (content addressing)`)
      }
    }
    const integrity = raw['integrity']
    if (isRecord(integrity) && integrity['status'] !== undefined && integrity['status'] !== 'ok') {
      issues.error(
        'snapshot.integrity',
        at,
        `snapshot integrity is "${String(integrity['status'])}" — a record carrying broken bytes must not validate as intact`,
      )
    }
    if (typeof raw['bytes'] !== 'number' || raw['bytes'] < 0) {
      issues.error('snapshot.bytes', at, 'snapshot.bytes must be a non-negative number')
    }
  }

  // ── evidence ─────────────────────────────────────────────────────────────
  const evidenceIds = checkIds(
    rawEvidence.map(raw => (isRecord(raw) ? raw['evidenceId'] : undefined)),
    '/evidence',
    issues,
  )
  for (const [index, raw] of rawEvidence.entries()) {
    const at = `/evidence/${index}`
    if (!isRecord(raw)) {
      issues.error('evidence.shape', at, 'evidence must be an object')
      continue
    }
    const boundRaw = raw['snapshotIds']
    if (!Array.isArray(boundRaw) || boundRaw.length === 0) {
      issues.error('evidence.no_snapshot', at, 'evidence without a snapshot is invalid by design')
    }
    const bound = new Set<string>()
    if (Array.isArray(boundRaw)) {
      for (const snapshotId of boundRaw) {
        if (typeof snapshotId !== 'string' || !HASH_REF.test(snapshotId)) {
          issues.error('evidence.snapshot_id', at, 'snapshotIds entries must be `sha256:<hex>` content addresses')
          continue
        }
        if (!snapshotIds.has(snapshotId)) {
          issues.error('evidence.snapshot_unknown', at, `bound snapshot ${snapshotId} is not in the record`)
        }
        bound.add(snapshotId)
      }
    }
    const anchorsRaw = raw['anchors']
    if (!Array.isArray(anchorsRaw) || anchorsRaw.length === 0) {
      issues.error('evidence.no_anchor', at, 'evidence needs at least one locator anchor')
    } else {
      checkAnchors(anchorsRaw, `${at}/anchors`, issues, snapshotIds, bound)
    }
    const checksRaw = raw['checks']
    if (checksRaw !== undefined) {
      if (!Array.isArray(checksRaw)) issues.error('check.shape', `${at}/checks`, 'checks must be an array')
      else checkCodes(checksRaw, `${at}/checks`, issues)
    }
  }

  // ── claims ───────────────────────────────────────────────────────────────
  checkIds(
    rawClaims.map(raw => (isRecord(raw) ? raw['claimId'] : undefined)),
    '/claims',
    issues,
  )
  for (const [index, raw] of rawClaims.entries()) {
    const at = `/claims/${index}`
    if (!isRecord(raw)) {
      issues.error('claim.shape', at, 'claim must be an object')
      continue
    }
    const refs = raw['evidenceRefs']
    if (!Array.isArray(refs)) {
      issues.error('claim.shape', at, 'evidenceRefs must be an array')
    } else {
      for (const ref of refs) {
        if (typeof ref !== 'string' || !evidenceIds.has(ref)) {
          issues.error('claim.evidence_unknown', at, `evidenceRef ${String(ref)} is not registered in this record`)
        }
      }
    }
    const checksRaw = raw['checks']
    if (!Array.isArray(checksRaw)) {
      issues.error('claim.shape', at, 'checks must be an array (it may be empty)')
    } else {
      checkCodes(checksRaw, `${at}/checks`, issues)
    }
    const locator = raw['locator']
    if (locator !== undefined) {
      if (!isRecord(locator)) issues.error('anchor.shape', `${at}/locator`, 'locator must be an anchor object')
      else checkAnchors([locator], `${at}/locator`, issues, snapshotIds)
    }
    const claim = raw as unknown as Claim
    if (typeof claim.text === 'string' && Array.isArray(claim.evidenceRefs) && Array.isArray(claim.checks)) {
      for (const violation of claimInvariantViolations(claim)) {
        issues.error('claim.verdict_invariant', at, violation)
      }
    }
  }

  // ── artifacts ────────────────────────────────────────────────────────────
  checkIds(
    rawArtifacts.map(raw => (isRecord(raw) ? raw['artifactId'] : undefined)),
    '/artifacts',
    issues,
  )

  // ── audit chain ──────────────────────────────────────────────────────────
  if (rawAudit.length > 0) {
    if (!rawAudit.every(isRecord)) {
      issues.error('audit.shape', '/audit', 'every audit event must be an object')
    } else {
      for (const defect of verifyAuditChain(rawAudit as unknown as AuditEvent[])) {
        const code = defect.code === 'event.prev_mismatch' || defect.code === 'event.unexpected_prev'
          ? 'audit.chain'
          : defect.code === 'event.duplicate_id'
            ? 'id.duplicate'
            : 'audit.hash_mismatch'
        issues.error(code, `/audit/${defect.index}`, defect.message)
      }
    }
  }

  // ── manifest ─────────────────────────────────────────────────────────────
  const manifestRaw = value['manifest']
  if (manifestRaw !== undefined) {
    if (!isRecord(manifestRaw)) {
      issues.error('manifest.shape', '/manifest', 'manifest must be an object')
    } else {
      const manifest = manifestRaw as unknown as ResearchRecord['manifest']
      if (manifest === undefined) {
        issues.error('manifest.shape', '/manifest', 'manifest must be an object')
      } else {
        const recordWithoutManifest = {
          schemaVersion: 1 as const,
          recordId: String(value['recordId']),
          createdAt: String(value['createdAt']),
          snapshots: rawSnapshots as readonly Snapshot[],
          evidence: rawEvidence as readonly Evidence[],
          claims: rawClaims as readonly Claim[],
          ...(rawArtifacts.length === 0 ? {} : { artifacts: rawArtifacts as readonly Artifact[] }),
        }
        const claimById = new Map<string, Claim>()
        for (const claim of recordWithoutManifest.claims) claimById.set(claim.claimId, claim)
        const evidenceById = new Map<string, Evidence>()
        for (const evidence of recordWithoutManifest.evidence) evidenceById.set(evidence.evidenceId, evidence)

        for (const [index, entry] of manifest.evidence.entries()) {
          const bound = evidenceById.get(entry.evidenceId)
          if (bound === undefined) {
            issues.error('manifest.evidence_unknown', `/manifest/evidence/${index}`, `unknown evidence ${entry.evidenceId}`)
            continue
          }
          if (evidenceStatusOf(bound) !== entry.status) {
            issues.error(
              'manifest.evidence_status_mismatch',
              `/manifest/evidence/${index}`,
              `manifest records status ${entry.status}, checks derive ${evidenceStatusOf(bound)}`,
            )
          }
        }
        for (const [index, entry] of manifest.claims.entries()) {
          const claim = claimById.get(entry.claimId)
          if (claim === undefined) {
            issues.error('manifest.claim_unknown', `/manifest/claims/${index}`, `unknown claim ${entry.claimId}`)
            continue
          }
          if (sha256Hex(claim.text) !== entry.textHash) {
            issues.error('manifest.text_hash_mismatch', `/manifest/claims/${index}`, 'claim text hash does not match the record')
          }
          if ((claim.verdict ?? 'unverified') !== entry.verdict) {
            issues.error(
              'manifest.verdict_mismatch',
              `/manifest/claims/${index}`,
              `manifest verdict ${entry.verdict} does not match the claim verdict ${String(claim.verdict)}`,
            )
          }
        }
        const expectedSummary = summarizeRecord(recordWithoutManifest)
        if (JSON.stringify(expectedSummary) !== JSON.stringify(manifest.summary)) {
          issues.error('manifest.summary_mismatch', '/manifest/summary', 'manifest counters do not match the record')
        }
        const seal = verifyManifestSeal(manifest)
        if (manifest.integrity === undefined) {
          issues.error('manifest.missing_seal', '/manifest/integrity', 'a report manifest must be sealed')
        } else if (!seal.ok) {
          issues.error(
            'manifest.seal_mismatch',
            '/manifest/integrity',
            `seal mismatch: recorded ${String(seal.recorded)}, recomputed ${seal.expected}`,
          )
        }
        if (manifestHashOf(manifest) !== seal.expected) {
          issues.error('manifest.seal_unstable', '/manifest', 'manifest hash is not stable across recomputation')
        }
      }
    }
  }

  return { ok: issues.list.every(issue => issue.severity !== 'error'), issues: issues.list }
}

/**
 * Convenience predicate for callers that only need pass/fail.
 * @param value - the parsed record.
 * @returns true when the record is valid.
 */
export function isValidRep(value: unknown): boolean {
  return validateRep(value).ok
}

/**
 * Filter the issues that should block a commit/seal.
 * @param result - a validation result.
 * @returns only the error-severity issues.
 */
export function repErrors(result: RepValidationResult): ValidationIssue[] {
  return result.issues.filter(issue => issue.severity === 'error')
}

/**
 * Type guard used by consumers that already validated.
 * @param value - a candidate record.
 * @returns whether this looks like a REP v1 record and validates.
 */
export function assertRep(value: unknown, label = 'record'): ResearchRecord {
  const result = validateRep(value)
  if (!result.ok) {
    const first = repErrors(result)[0]
    throw new TypeError(`${label} is not a valid REP v1 record: ${first?.code ?? 'unknown'} ${first?.message ?? ''}`)
  }
  return value as ResearchRecord
}

/** Re-export so callers can type an anchor without importing the types module twice. */
export type { Anchor }
