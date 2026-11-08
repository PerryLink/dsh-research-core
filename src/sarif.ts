/**
 * SARIF 2.1.0 export.
 *
 * CI consumers (GitHub code scanning, IDE plugins) understand SARIF, so every
 * REP finding can be surfaced without a custom integration. Physical locations
 * point at the content-addressed snapshot (`rep://sha256/<hex>`); the precise
 * in-document locator travels as a `logicalLocation` and in `properties`.
 *
 * @module @perrylink/dsh-research-core/sarif
 */

import type { Anchor, CheckResult, Claim, Evidence, ResearchRecord } from './types.ts'
import type { ValidationIssue } from './validate.ts'

/** Minimal SARIF 2.1.0 shapes (only what REP emits). */
export interface SarifLog {
  readonly $schema: string
  readonly version: '2.1.0'
  readonly runs: readonly SarifRun[]
}

/** One SARIF run. */
export interface SarifRun {
  readonly tool: {
    readonly driver: {
      readonly name: string
      readonly version: string
      readonly informationUri?: string
      readonly rules?: readonly SarifRule[]
    }
  }
  readonly artifacts?: readonly SarifArtifact[]
  readonly results: readonly SarifResult[]
}

/** One SARIF rule. */
export interface SarifRule {
  readonly id: string
  readonly name: string
  readonly shortDescription: { readonly text: string }
  readonly helpUri?: string
}

/** One SARIF artifact reference. */
export interface SarifArtifact {
  readonly location: { readonly uri: string }
  readonly mimeType?: string
}

/** One SARIF result. */
export interface SarifResult {
  readonly ruleId: string
  readonly level: 'error' | 'warning' | 'note'
  readonly message: { readonly text: string }
  readonly locations?: readonly {
    readonly physicalLocation: {
      readonly artifactLocation: { readonly uri: string; readonly index?: number }
      readonly region?: { readonly startLine: number; readonly startColumn?: number }
    }
    readonly logicalLocations?: readonly { readonly fullyQualifiedName: string; readonly kind?: string }[]
  }[]
  readonly properties?: Record<string, unknown>
}

/** Options for {@link toSarif}. */
export interface SarifOptions {
  /** Tool version recorded in the driver. */
  readonly version?: string
  /** Also emit `not_found` / skipped checks as notes (default false). */
  readonly includeSkipped?: boolean
  /** Rule help URI. */
  readonly informationUri?: string
}

/** Encode a snapshot address as a stable URI. */
export function snapshotUri(snapshotId: string): string {
  return `rep://${snapshotId.replace(':', '/')}`
}

/** Map a check status to a SARIF level. */
function levelOf(check: CheckResult): SarifResult['level'] | undefined {
  if (check.status === 'fail') return check.severity === 'warning' ? 'warning' : 'error'
  if (check.status === 'warn') return 'warning'
  if (check.status === 'skipped' && check.code === 'not_found') return 'note'
  return undefined
}

/** Build the physical location for one locator. */
function locationOf(
  anchor: Anchor | undefined,
  artifactIndex: (id: string) => number,
): SarifResult['locations'] {
  if (anchor === undefined) return undefined
  return [
    {
      physicalLocation: {
        artifactLocation: { uri: snapshotUri(anchor.snapshotId), index: artifactIndex(anchor.snapshotId) },
        region: { startLine: 1 },
      },
      logicalLocations: [{ fullyQualifiedName: anchor.value, kind: anchor.kind }],
    },
  ]
}

/** Rule catalogue keyed by check kind. */
const RULES: Readonly<Record<string, { name: string; description: string }>> = {
  'rep/doi-exists': { name: 'doi-exists', description: 'The cited identifier does not resolve to a metadata record.' },
  'rep/metadata-match': { name: 'metadata-match', description: 'Bibliographic fields do not match the authoritative record.' },
  'rep/quote-span': { name: 'quote-span', description: 'A claimed quote is not present verbatim in the bound snapshot.' },
  'rep/number-match': { name: 'number-match', description: 'A claimed number does not occur in the bound snapshot.' },
  'rep/retraction': { name: 'retraction', description: 'The cited work is retracted, corrected or under an expression of concern.' },
  'rep/version-match': { name: 'version-match', description: 'Preprint and published versions disagree.' },
  'rep/duplicate': { name: 'duplicate', description: 'The citation appears more than once.' },
  'rep/stat-consistency': { name: 'stat-consistency', description: 'A reported statistic is inconsistent with its recomputed value.' },
  'rep/artifact-match': { name: 'artifact-match', description: 'A reproducibility artifact does not match the recorded hash.' },
  'rep/evidence-present': { name: 'evidence-present', description: 'A claim has no (or unresolvable) bound evidence.' },
  'rep/source-status': { name: 'source-status', description: 'A bound snapshot failed its integrity check.' },
  'rep/other': { name: 'other', description: 'Other research-evidence finding.' },
}

/** Build the rule id for one check kind. */
function ruleIdOf(check: CheckResult['check']): string {
  const id = `rep/${check}`
  return RULES[id] === undefined ? 'rep/other' : id
}

/** Context carried into a result message. */
interface FindingContext {
  readonly claim?: Claim
  readonly evidence?: Evidence
}

/**
 * Export a record's failing and warning checks as SARIF.
 * @param record - the REP record.
 * @param options - tool version and noise level.
 * @returns a SARIF 2.1.0 log.
 */
export function toSarif(record: ResearchRecord | { readonly evidence: readonly Evidence[]; readonly claims: readonly Claim[]; readonly snapshots: readonly { snapshotId: string; mediaType?: string }[] }, options: SarifOptions = {}): SarifLog {
  const artifacts: SarifArtifact[] = []
  const indexByUri = new Map<string, number>()
  const artifactIndex = (snapshotId: string): number => {
    const uri = snapshotUri(snapshotId)
    const existing = indexByUri.get(uri)
    if (existing !== undefined) return existing
    const index = artifacts.length
    indexByUri.set(uri, index)
    const mediaType = record.snapshots.find(snapshot => snapshot.snapshotId === snapshotId)?.mediaType
    artifacts.push({ location: { uri }, ...(mediaType === undefined ? {} : { mimeType: mediaType }) })
    return index
  }

  const results: SarifResult[] = []
  const pushCheck = (check: CheckResult, context: FindingContext): void => {
    const level = levelOf(check)
    if (level === undefined) return
    if (check.status === 'skipped' && options.includeSkipped !== true) return
    const ruleId = ruleIdOf(check.check)
    const label = context.claim === undefined ? (context.evidence?.evidenceId ?? '') : context.claim.claimId
    results.push({
      ruleId,
      level,
      message: {
        text: context.claim === undefined
          ? check.detail
          : `${check.detail} (claim ${label}: ${context.claim.text.slice(0, 240)})`,
      },
      ...(locationOf(check.locator ?? context.claim?.locator, artifactIndex) === undefined
        ? {}
        : { locations: locationOf(check.locator ?? context.claim?.locator, artifactIndex) ?? [] }),
      properties: {
        checkId: check.checkId,
        status: check.status,
        ...(check.code === undefined ? {} : { code: check.code }),
        ...(check.expected === undefined ? {} : { expected: check.expected }),
        ...(check.actual === undefined ? {} : { actual: check.actual }),
        ...(context.evidence === undefined ? {} : { evidenceId: context.evidence.evidenceId }),
        ...(context.claim === undefined ? {} : { claimId: context.claim.claimId, claimType: context.claim.type }),
      },
    })
  }

  for (const evidence of record.evidence) {
    for (const check of evidence.checks ?? []) pushCheck(check, { evidence })
  }
  for (const claim of record.claims) {
    for (const check of claim.checks) pushCheck(check, { claim })
    // A claim whose verdict is not `verified` is itself a finding when it is
    // contradicted/disproven and no failing check was recorded.
    if (
      (claim.verdict === 'contradicted' || claim.verdict === 'disproven') &&
      !claim.checks.some(check => check.status === 'fail')
    ) {
      results.push({
        ruleId: 'rep/other',
        level: 'error',
        message: { text: `claim ${claim.claimId} is ${claim.verdict} without a failing check: ${claim.text.slice(0, 240)}` },
        ...(locationOf(claim.locator, artifactIndex) === undefined ? {} : { locations: locationOf(claim.locator, artifactIndex) ?? [] }),
        properties: { claimId: claim.claimId, verdict: claim.verdict },
      })
    }
  }

  const usedRules = [...new Set(results.map(result => result.ruleId))]
  const rules: SarifRule[] = usedRules.map(id => ({
    id,
    name: RULES[id]?.name ?? 'other',
    shortDescription: { text: RULES[id]?.description ?? 'Research-evidence finding.' },
  }))

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: '@perrylink/dsh-research-core',
            version: options.version ?? '0.0.0',
            ...(options.informationUri === undefined ? {} : { informationUri: options.informationUri }),
            ...(rules.length === 0 ? {} : { rules }),
          },
        },
        ...(artifacts.length === 0 ? {} : { artifacts }),
        results,
      },
    ],
  }
}

/**
 * Export invariant violations (a record that does not validate) as SARIF.
 * @param issues - validation issues.
 * @param options - tool version.
 * @returns a SARIF log.
 */
export function validationToSarif(issues: readonly ValidationIssue[], options: SarifOptions = {}): SarifLog {
  const results: SarifResult[] = issues
    .filter(issue => issue.severity === 'error')
    .map(issue => ({
      ruleId: `rep/invariant/${issue.code}`,
      level: 'error',
      message: { text: `${issue.code} at ${issue.path || '/'}: ${issue.message}` },
      properties: { code: issue.code, path: issue.path },
    }))
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: '@perrylink/dsh-research-core',
            version: options.version ?? '0.0.0',
            ...(options.informationUri === undefined ? {} : { informationUri: options.informationUri }),
          },
        },
        results,
      },
    ],
  }
}
