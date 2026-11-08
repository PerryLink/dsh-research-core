/**
 * `@perrylink/dsh-research-core` — REP v1, the shared Research Evidence
 * Protocol for the DSH research plugin family.
 *
 * The package is two things in one artifact:
 * 1. a zero-runtime-dependency library (JSON Schema, TypeScript types, hashing,
 *    canonical JSON, invariant validation, verification, SARIF, manifest seals,
 *    audit chains, a content-addressed store), and
 * 2. an optional Cordis plugin that mounts `ctx.researchEvidence`.
 *
 * It deliberately does NOT retrieve, parse, or check anything domain-specific:
 * those are the 18 single-purpose plugins. Core only guarantees that what they
 * produce can be reproduced and composed.
 *
 * Function plugin — no default export (the Loader unwraps
 * `exports.default ?? exports`, and a stray default would discard
 * `name`/`apply`).
 *
 * @module @perrylink/dsh-research-core
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolveConfig } from './config.ts'
import type { Config } from './config.ts'
import { LocalResearchEvidenceService } from './provider-local.ts'
import type { ReportServiceLike } from './service.ts'

/** Cordis plugin name. */
export const name = 'research-core'

/**
 * No required services: core is usable standalone. `ctx.researchReport` is
 * resolved OPTIONALLY at mount time for the legacy-ledger bridge.
 */
export const inject: string[] = []

export { Config, resolveConfig } from './config.ts'
export type { ResolvedConfig } from './config.ts'
export { VERSION } from './version.ts'

// ── Protocol types ──────────────────────────────────────────────────────────
export type {
  Anchor,
  AnchorKind,
  Artifact,
  ArtifactKind,
  AuditEvent,
  CheckCode,
  CheckKind,
  CheckResult,
  CheckStatus,
  Claim,
  ClaimType,
  Evidence,
  Generator,
  HashRef,
  IsoTimestamp,
  ManifestClaimEntry,
  ManifestEvidenceEntry,
  ManifestEvidenceStatus,
  ManifestSummary,
  Provenance,
  RepId,
  RepSchemaVersion,
  ReportManifest,
  ResearchRecord,
  Sha256Hex,
  Snapshot,
  SnapshotIntegrity,
  SnapshotIntegrityStatus,
  SnapshotMediaType,
  SourceKind,
  SourceMetadata,
  SourceRef,
  Verdict,
} from './types.ts'

// ── Pure protocol helpers ───────────────────────────────────────────────────
export { CanonicalJsonError, canonicalJson, normalizeJson } from './canonical.ts'
export {
  HASH_REF_PATTERN,
  claimTextHash,
  hashRefHex,
  isHashRef,
  objectPathOf,
  sha256Hex,
  sha256Json,
  snapshotIdOf,
  stableId,
} from './hash.ts'
export { RESEARCH_EVENTS } from './events.ts'
export type {
  AuditFindingEvent,
  ClaimVerifiedEvent,
  EvidenceCapturedEvent,
  ReportSealedEvent,
} from './events.ts'
export { auditEventHash, createAuditEvent, verifyAuditChain } from './audit.ts'
export type { AuditChainIssue, AuditEventInput } from './audit.ts'
export {
  VERIFYING_CHECKS,
  claimInvariantViolations,
  evaluateClaim,
  extractNumericTokens,
  normalizeText,
  numericTokensEqual,
} from './claim.ts'
export type { ClaimEvaluation, ClaimEvidenceText, NumericToken } from './claim.ts'
export {
  VERDICTS,
  buildManifest,
  evidenceStatusOf,
  manifestHashOf,
  sealManifest,
  summarizeRecord,
  verifyManifestSeal,
} from './manifest.ts'
export type { BuildManifestOptions, ManifestSealCheck } from './manifest.ts'
export { isValidRep, repErrors, validateRep } from './validate.ts'
export type { RepValidationResult, ValidationIssue } from './validate.ts'
export {
  decodeSnapshotText,
  evidenceTextsOf,
  fileSnapshotReader,
  isTextualMediaType,
  verifyRecord,
  verifyRecordFile,
} from './verify.ts'
export type {
  AnchorVerification,
  RecordVerification,
  SnapshotReader,
  SnapshotVerification,
  VerifyRecordOptions,
} from './verify.ts'
export { REP_SCHEMA_ID, REP_SCHEMA_VERSION, getRepSchema } from './schema.ts'
export { toSarif, validationToSarif, snapshotUri } from './sarif.ts'
export type { SarifArtifact, SarifLog, SarifOptions, SarifResult, SarifRule, SarifRun } from './sarif.ts'
export { VERDICT_MARK, renderRecordMarkdown, renderReportMarkdown } from './report.ts'

// ── Service + local provider ────────────────────────────────────────────────
export { ResearchEvidenceService } from './service.ts'
export type { ReportEvidenceRecord, ReportServiceLike } from './service.ts'
export {
  EvidenceStore,
  RepStoreError,
  snapshotTextOf,
} from './store.ts'
export type {
  AddClaimInput,
  AddEvidenceInput,
  BuildRecordOptions,
  CaptureInput,
  CaptureResult,
  EvidenceStoreOptions,
  RepStoreErrorCode,
  SealOptions,
  SealResult,
  SetVerdictOptions,
  SnapshotView,
} from './store.ts'
export { LocalResearchEvidenceService } from './provider-local.ts'

/**
 * Mount the REP service.
 *
 * Config is validated eagerly (fail loud on a bad bound). When
 * `enabled: false`, nothing at all is mounted. When `ctx.researchReport` is
 * already present, the local provider attaches to it so plugins can bridge
 * legacy evidence without either package importing the other.
 * @param ctx - the plugin context (host).
 * @param config - raw plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const logger = ctx.logger('research-core')
  if (!resolved.enabled) {
    logger.info('disabled: enabled is false — ctx.researchEvidence is not mounted')
    return
  }
  const service = new LocalResearchEvidenceService(ctx, resolved)
  const report = ctx.get('researchReport') as ReportServiceLike | undefined
  if (report !== undefined) {
    service.attachReport(report)
    logger.info('bridged to ctx.researchReport (legacy evidence can be imported / mirrored)')
  }
  logger.info(`REP store ready at ${resolved.root} (REP v1, schema frozen)`)
}
