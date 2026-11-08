/**
 * Sealed report manifests.
 *
 * The seal is the SHA-256 of the canonical JSON of the manifest with its
 * `integrity` member removed. Anyone holding the manifest file can recompute
 * it, so a changed verdict, claim text hash or evidence binding is detectable
 * without trusting the producer.
 *
 * @module @perrylink/dsh-research-core/manifest
 */

import { sha256Hex, sha256Json, stableId } from './hash.ts'
import type {
  Artifact,
  CheckResult,
  Evidence,
  Generator,
  IsoTimestamp,
  ManifestClaimEntry,
  ManifestEvidenceEntry,
  ManifestEvidenceStatus,
  ManifestSummary,
  ReportManifest,
  ResearchRecord,
  Verdict,
} from './types.ts'

/** The five verdicts, in canonical order. */
export const VERDICTS: readonly Verdict[] = ['verified', 'unverified', 'insufficient', 'contradicted', 'disproven']

/** True for a plain object (runtime data may come from JSON, not TypeScript). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Keep only object-shaped checks. This module is also used by the defensive
 * validator, which must report malformed input instead of throwing on it.
 */
function usableChecks(value: unknown): CheckResult[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is CheckResult => isPlainObject(item))
}

/**
 * Derive the manifest status of one evidence item from its checks.
 *
 * A `not_found` outcome never yields `ok`: "we could not find it" is not
 * evidence that the source is fine.
 * @param evidence - the evidence item.
 * @returns its manifest status.
 */
export function evidenceStatusOf(evidence: Evidence): ManifestEvidenceStatus {
  const checks = usableChecks(evidence?.checks)
  if (checks.length === 0) return 'unchecked'
  if (checks.some(check => check.status === 'fail')) return 'fail'
  if (checks.some(check => check.status === 'warn')) return 'warn'
  if (checks.some(check => check.status === 'skipped' && check.code === 'not_found')) return 'unchecked'
  if (checks.some(check => check.status === 'pass')) return 'ok'
  return 'unchecked'
}

/** Every check reachable from a record (evidence checks + claim checks). */
function allChecks(record: Omit<ResearchRecord, 'manifest'>): CheckResult[] {
  const checks: CheckResult[] = []
  for (const evidence of Array.isArray(record.evidence) ? record.evidence : []) {
    checks.push(...usableChecks(evidence?.checks))
  }
  for (const claim of Array.isArray(record.claims) ? record.claims : []) {
    checks.push(...usableChecks(claim?.checks))
  }
  return checks
}

/**
 * Summarize a record for the manifest.
 * @param record - the record without its manifest.
 * @returns the aggregate counters.
 */
export function summarizeRecord(record: Omit<ResearchRecord, 'manifest'>): ManifestSummary {
  const verdictCounts: Record<Verdict, number> = {
    verified: 0,
    unverified: 0,
    insufficient: 0,
    contradicted: 0,
    disproven: 0,
  }
  const claims = Array.isArray(record.claims) ? record.claims : []
  for (const claim of claims) {
    const verdict = isPlainObject(claim) && typeof claim['verdict'] === 'string' ? claim['verdict'] : 'unverified'
    if ((VERDICTS as readonly string[]).includes(verdict)) verdictCounts[verdict as Verdict] += 1
    else verdictCounts.unverified += 1
  }
  const checks = allChecks(record)
  return {
    evidenceCount: Array.isArray(record.evidence) ? record.evidence.length : 0,
    claimCount: claims.length,
    snapshotCount: Array.isArray(record.snapshots) ? record.snapshots.length : 0,
    verdictCounts,
    failedChecks: checks.filter(check => check.status === 'fail').length,
    notFoundChecks: checks.filter(check => check.code === 'not_found').length,
  }
}

/** Options accepted by {@link buildManifest}. */
export interface BuildManifestOptions {
  /** Report title. */
  readonly title: string
  /** Report topic / slug. */
  readonly topic: string
  /** Producing tool identity. */
  readonly generator: Generator
  /** Explicit manifest id; derived from the content when omitted. */
  readonly manifestId?: string
  /** Generation time; defaults to the record's `createdAt`. */
  readonly generatedAt?: IsoTimestamp
  /** Record file name relative to the manifest. */
  readonly recordFile?: string
  /** Limitations the producer wants carried with the report. */
  readonly limitations?: readonly string[]
}

/**
 * Build an unsealed manifest from a record.
 * @param record - the record without its manifest.
 * @param options - report identity.
 * @returns the manifest (no `integrity` yet).
 */
export function buildManifest(record: Omit<ResearchRecord, 'manifest'>, options: BuildManifestOptions): ReportManifest {
  const generatedAt = options.generatedAt ?? record.createdAt
  const evidence: ManifestEvidenceEntry[] = record.evidence.map(item => ({
    evidenceId: item.evidenceId,
    snapshotIds: item.snapshotIds,
    status: evidenceStatusOf(item),
  }))
  const claims: ManifestClaimEntry[] = record.claims.map(claim => ({
    claimId: claim.claimId,
    textHash: sha256Hex(claim.text),
    verdict: claim.verdict ?? 'unverified',
    evidenceRefs: claim.evidenceRefs,
  }))
  const artifacts: readonly Artifact[] | undefined = record.artifacts
  return {
    schemaVersion: 1,
    manifestId: options.manifestId ?? stableId('man', [options.title, options.topic, generatedAt]),
    generatedAt,
    title: options.title,
    topic: options.topic,
    generator: options.generator,
    ...(options.recordFile === undefined ? {} : { recordFile: options.recordFile }),
    evidence,
    claims,
    ...(artifacts === undefined ? {} : { artifacts }),
    summary: summarizeRecord(record),
    ...(options.limitations === undefined ? {} : { limitations: options.limitations }),
  }
}

/**
 * Compute the seal hash: canonical JSON of the manifest without `integrity`.
 * @param manifest - the manifest (sealed or not).
 * @returns the lowercase hex digest.
 */
export function manifestHashOf(manifest: ReportManifest): string {
  const copy: Record<string, unknown> = { ...manifest }
  delete copy['integrity']
  return sha256Json(copy)
}

/**
 * Attach the seal.
 * @param manifest - the unsealed manifest.
 * @param sealedAt - seal time (defaults to `generatedAt`).
 * @returns the sealed manifest.
 */
export function sealManifest(manifest: ReportManifest, sealedAt?: IsoTimestamp): ReportManifest {
  return {
    ...manifest,
    integrity: {
      algorithm: 'sha256',
      manifestHash: manifestHashOf(manifest),
      ...(sealedAt === undefined ? {} : { sealedAt }),
    },
  }
}

/** The outcome of re-computing a manifest seal. */
export interface ManifestSealCheck {
  /** Whether the recorded seal equals the recomputed one. */
  readonly ok: boolean
  /** The value recomputed from the manifest body. */
  readonly expected: string
  /** The value recorded in `integrity`, when present. */
  readonly recorded?: string
}

/**
 * Recompute the seal of a sealed manifest.
 * @param manifest - the manifest to check.
 * @returns the seal comparison.
 */
export function verifyManifestSeal(manifest: ReportManifest): ManifestSealCheck {
  const expected = manifestHashOf(manifest)
  const recorded = manifest.integrity?.manifestHash
  return {
    ok: recorded !== undefined && recorded === expected,
    expected,
    ...(recorded === undefined ? {} : { recorded }),
  }
}
