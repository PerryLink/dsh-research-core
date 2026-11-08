/**
 * REP v1 — TypeScript mirror of `schema/rep-v1.schema.json`.
 *
 * The JSON Schema is the published structural contract; these types are the
 * compile-time mirror used by every research plugin. Field names, enums and
 * optionality are kept 1:1 with the schema — a change here MUST be accompanied
 * by the same change in the schema file and a `schemaVersion` bump.
 *
 * @module @perrylink/dsh-research-core/types
 */

/** The protocol version. A breaking change requires a new version + migration. */
export type RepSchemaVersion = 1

/** RFC 3339 timestamp with an explicit offset (UTC is `...Z`). */
export type IsoTimestamp = string

/** Lowercase hex SHA-256 digest. */
export type Sha256Hex = string

/** Self-describing content address: `sha256:<hex64>`. */
export type HashRef = `sha256:${string}`

/** Stable identifier: starts alphanumeric, then `[A-Za-z0-9._:-]`, max 128. */
export type RepId = string

/** How a source is identified. */
export type SourceKind = 'doi' | 'pmid' | 'pmcid' | 'arxiv' | 'isbn' | 'url' | 'file' | 'dataset' | 'other'

/** Bibliographic metadata carried with a source reference (all optional). */
export interface SourceMetadata {
  readonly title?: string
  readonly authors?: readonly string[]
  readonly year?: number
  readonly containerTitle?: string
  readonly volume?: string
  readonly issue?: string
  readonly pages?: string
  readonly publisher?: string
  readonly version?: string
  readonly type?: string
  readonly language?: string
  readonly issn?: string
  readonly license?: string
}

/** Where an evidence item came from, and when it was retrieved. */
export interface SourceRef {
  readonly kind: SourceKind
  readonly id: string
  readonly url?: string
  readonly retrievedAt: IsoTimestamp
  readonly metadata?: SourceMetadata
}

/** Media types REP v1 can address. */
export type SnapshotMediaType =
  | 'application/pdf'
  | 'text/html'
  | 'text/x-latex'
  | 'text/plain'
  | 'text/markdown'
  | 'text/csv'
  | 'application/json'
  | 'application/x-ndjson'
  | 'application/x-bibtex'
  | 'application/xml'
  | 'text/xml'
  | 'image/png'
  | 'image/jpeg'
  | 'image/tiff'
  | 'application/octet-stream'

/** Integrity state computed by re-hashing the stored object. */
export type SnapshotIntegrityStatus = 'ok' | 'tampered' | 'missing'

/** Integrity observation attached to a snapshot when it is known. */
export interface SnapshotIntegrity {
  readonly status: SnapshotIntegrityStatus
  readonly checkedAt?: IsoTimestamp
}

/**
 * One immutable, content-addressed snapshot.
 *
 * `snapshotId` is `sha256:<hex>` of the bytes, and `path` MUST equal
 * `objects/<hex>` — content addressing is an invariant, not a convention.
 */
export interface Snapshot {
  readonly snapshotId: HashRef
  readonly mediaType: SnapshotMediaType
  readonly bytes: number
  readonly path: string
  readonly capturedAt: IsoTimestamp
  readonly sourceRef: SourceRef
  readonly encoding?: 'utf-8' | 'binary'
  readonly integrity?: SnapshotIntegrity
}

/** Locator kinds. Each kind has a canonical `value` form. */
export type AnchorKind = 'page' | 'section' | 'paragraph' | 'char' | 'table' | 'figure' | 'record'

/**
 * A locator into one snapshot.
 *
 * Canonical `value` forms: `p.3` (page), `c.1024-1103` (char range),
 * `para.7` (paragraph), `t.2` (table), `f.1` (figure), `field:title`
 * (structured-record field), free-form section path for sections.
 */
export interface Anchor {
  readonly anchorId?: RepId
  readonly snapshotId: HashRef
  readonly kind: AnchorKind
  readonly value: string
  readonly quote?: string
  readonly quoteHash?: Sha256Hex
  readonly page?: number
  readonly charRange?: { readonly start: number; readonly end: number }
  readonly paragraph?: number
  readonly ordinal?: number
  readonly section?: string
  readonly bbox?: readonly [number, number, number, number]
  readonly label?: string
}

/** How one evidence item was produced. */
export interface Provenance {
  readonly plugin: string
  readonly version: string
  readonly method: string
  readonly retrievedAt: IsoTimestamp
  readonly inputHash?: Sha256Hex
  readonly toolRun?: string
}

/** What a check verifies. */
export type CheckKind =
  | 'doi-exists'
  | 'metadata-match'
  | 'quote-span'
  | 'number-match'
  | 'retraction'
  | 'version-match'
  | 'duplicate'
  | 'stat-consistency'
  | 'artifact-match'
  | 'evidence-present'
  | 'source-status'
  | 'other'

/** A check outcome. `skipped` is a first-class outcome, not a soft pass. */
export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skipped'

/**
 * Machine-readable reason for a non-pass outcome.
 *
 * `not_found` is deliberately documented: it means the source could not be
 * located. It is NOT evidence of fabrication and NOT evidence of cleanliness.
 */
export type CheckCode =
  | 'not_found'
  | 'rate_limited'
  | 'network_error'
  | 'parse_failed'
  | 'ambiguous_match'
  | 'outside_tolerance'
  | 'insufficient_evidence'
  | 'not_applicable'
  | 'unavailable'
  | 'unsupported_media_type'
  | 'integrity_mismatch'

/** One deterministic check result. */
export interface CheckResult {
  readonly checkId: RepId
  readonly check: CheckKind
  readonly status: CheckStatus
  readonly code?: CheckCode
  readonly severity?: 'info' | 'warning' | 'error'
  readonly detail: string
  readonly expected?: unknown
  readonly actual?: unknown
  readonly locator?: Anchor
  readonly checkedAt?: IsoTimestamp
  readonly tool?: { readonly name: string; readonly version: string }
}

/**
 * An evidence item: a source, at least one snapshot, at least one anchor and
 * its provenance. Evidence without a snapshot is invalid by construction.
 */
export interface Evidence {
  readonly evidenceId: RepId
  readonly title?: string
  readonly sourceRef: SourceRef
  readonly snapshotIds: readonly HashRef[]
  readonly anchors: readonly Anchor[]
  readonly provenance: Provenance
  readonly checks?: readonly CheckResult[]
  readonly labels?: readonly string[]
  readonly notes?: string
}

/** What kind of assertion a claim makes. */
export type ClaimType = 'result' | 'method' | 'background' | 'conclusion' | 'number' | 'quote' | 'metadata' | 'other'

/**
 * The five verdicts. `verified` is only legal with bound evidence and at least
 * one passing verifying check; `insufficient` means "cannot decide from what is
 * available" — never "false".
 */
export type Verdict = 'verified' | 'unverified' | 'insufficient' | 'contradicted' | 'disproven'

/** One assertion, its bound evidence, its checks and its verdict. */
export interface Claim {
  readonly claimId: RepId
  readonly text: string
  readonly type: ClaimType
  readonly evidenceRefs: readonly RepId[]
  readonly checks: readonly CheckResult[]
  readonly verdict?: Verdict
  readonly verdictAt?: IsoTimestamp
  readonly locator?: Anchor
  readonly tolerance?: number
  readonly notes?: string
}

/** Artifact kinds tracked for reproducibility. */
export type ArtifactKind = 'code' | 'env' | 'data' | 'seed' | 'command' | 'figure' | 'table' | 'notebook' | 'config' | 'other'

/** A reproducibility artifact (code, environment, data, seed, command, figure…). */
export interface Artifact {
  readonly artifactId: RepId
  readonly kind: ArtifactKind
  readonly hash: HashRef
  readonly path?: string
  readonly mediaType?: string
  readonly bytes?: number
  readonly description?: string
  readonly producedBy?: { readonly plugin: string; readonly version: string }
  readonly createdAt?: IsoTimestamp
  readonly relatedEvidence?: readonly RepId[]
}

/** One append-only, hash-chained audit event. */
export interface AuditEvent {
  readonly eventId: RepId
  readonly at: IsoTimestamp
  readonly actor: 'plugin' | 'model' | 'human' | 'system'
  readonly type: string
  readonly payload: Record<string, unknown>
  readonly prevHash?: Sha256Hex
  readonly hash: Sha256Hex
}

/** The tool that produced a record, manifest or check. */
export interface Generator {
  readonly name: string
  readonly version: string
  readonly command?: string
  readonly dshVersion?: string
}

/** Integrity status recorded for one evidence item in a manifest. */
export type ManifestEvidenceStatus = 'ok' | 'warn' | 'fail' | 'unchecked'

/** One evidence entry in a sealed report manifest. */
export interface ManifestEvidenceEntry {
  readonly evidenceId: RepId
  readonly snapshotIds: readonly HashRef[]
  readonly status: ManifestEvidenceStatus
}

/** One claim entry in a sealed report manifest. */
export interface ManifestClaimEntry {
  readonly claimId: RepId
  readonly textHash: Sha256Hex
  readonly verdict: Verdict
  readonly evidenceRefs: readonly RepId[]
}

/** Aggregate counts sealed into a manifest. */
export interface ManifestSummary {
  readonly evidenceCount: number
  readonly claimCount: number
  readonly snapshotCount: number
  readonly verdictCounts: Readonly<Record<Verdict, number>>
  readonly failedChecks: number
  readonly notFoundChecks: number
}

/**
 * The sealed report manifest. `integrity.manifestHash` is the SHA-256 of the
 * canonical JSON of this object with `integrity` removed.
 */
export interface ReportManifest {
  readonly schemaVersion: 1
  readonly manifestId: RepId
  readonly generatedAt: IsoTimestamp
  readonly title: string
  readonly topic: string
  readonly generator: Generator
  readonly recordFile?: string
  readonly evidence: readonly ManifestEvidenceEntry[]
  readonly claims: readonly ManifestClaimEntry[]
  readonly artifacts?: readonly Artifact[]
  readonly summary: ManifestSummary
  readonly limitations?: readonly string[]
  readonly integrity?: {
    readonly algorithm: 'sha256'
    readonly manifestHash: Sha256Hex
    readonly sealedAt?: IsoTimestamp
  }
}

/** The complete REP v1 interchange record. */
export interface ResearchRecord {
  readonly schemaVersion: 1
  readonly recordId: RepId
  readonly createdAt: IsoTimestamp
  readonly generator?: Generator
  readonly snapshots: readonly Snapshot[]
  readonly evidence: readonly Evidence[]
  readonly claims: readonly Claim[]
  readonly artifacts?: readonly Artifact[]
  readonly audit?: readonly AuditEvent[]
  readonly manifest?: ReportManifest
  readonly notes?: readonly string[]
}
