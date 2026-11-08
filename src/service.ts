/**
 * Service Definition of the REP seam (`ctx.researchEvidence`).
 *
 * This is the Definition role: the abstract contract plus the structural bridge
 * to the legacy `ctx.researchReport` ledger. `provider-local.ts` is the local
 * Provider (content-addressed store); consumers are the research plugins.
 *
 * Plugins inject this service OPTIONALLY: when it is absent they can fall back
 * to their own JSON output. Nothing here requires `dsh-research-report`; when
 * that plugin IS mounted, {@link ResearchEvidenceService.attachReport} lets a
 * plugin read/import its evidence without either package importing the other.
 *
 * @module @perrylink/dsh-research-core/service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  CheckResult,
  Claim,
  Evidence,
  HashRef,
  ManifestSummary,
  ResearchRecord,
  Snapshot,
  Verdict,
} from './types.ts'
import type {
  AddClaimInput,
  AddEvidenceInput,
  BuildRecordOptions,
  CaptureInput,
  CaptureResult,
  SealOptions,
  SealResult,
  SetVerdictOptions,
  SnapshotView,
} from './store.ts'
import type { RecordVerification, VerifyRecordOptions } from './verify.ts'

/**
 * Structural view of one `dsh-research-report` evidence record.
 * Deliberately structural: core never imports that package.
 */
export interface ReportEvidenceRecord {
  readonly id: string
  readonly hash: string
  readonly title: string
  readonly origin: string
  readonly capturedAt: string
  readonly bytes: number
  readonly journal?: string
  readonly year?: string
}

/**
 * Structural view of the `ctx.researchReport` service surface core needs to
 * bridge. A host without that service simply passes `undefined`.
 */
export interface ReportServiceLike {
  /**
   * Register one evidence snapshot in the legacy ledger.
   * @param input - the snapshot and its provenance.
   * @returns the durable record and whether it already existed.
   */
  addEvidence(input: {
    readonly id?: string
    readonly title: string
    readonly origin: string
    readonly content: string
    readonly capturedAt?: string
    readonly journal?: string
    readonly year?: string
  }): Promise<{ readonly record: ReportEvidenceRecord; readonly deduplicated: boolean }>
  /**
   * Read one legacy evidence record.
   * @param evidenceId - the ledger id.
   * @returns the record, or undefined when unknown.
   */
  getEvidence(evidenceId: string): Promise<ReportEvidenceRecord | undefined>
  /**
   * Read one legacy snapshot's content (re-hashed by that provider).
   * @param evidenceId - the ledger id.
   * @returns the content plus integrity, or undefined when unknown.
   */
  readEvidenceContent(evidenceId: string): Promise<{ readonly content: string; readonly integrity: 'ok' | 'tampered' | 'missing' } | undefined>
  /**
   * List every legacy evidence record.
   * @returns the records in registration order.
   */
  listEvidence(): Promise<readonly ReportEvidenceRecord[]>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The REP evidence service (`@perrylink/dsh-research-core`), when mounted. */
    researchEvidence: ResearchEvidenceService
  }
}

/**
 * The Research Evidence Protocol service.
 *
 * Every method is deterministic and local: no method performs network I/O, and
 * no method silently repairs a mismatched hash.
 */
export abstract class ResearchEvidenceService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'researchEvidence')
  }

  /** Register snapshot bytes (content-addressed, immutable). */
  abstract capture(input: CaptureInput): Promise<CaptureResult>

  /** Register an evidence item bound to stored snapshots. */
  abstract addEvidence(input: AddEvidenceInput): Promise<{ readonly evidence: Evidence; readonly deduplicated: boolean }>

  /** Replace the checks recorded for one evidence item. */
  abstract setEvidenceChecks(evidenceId: string, checks: readonly CheckResult[]): Promise<Evidence>

  /** Register a claim and its evidence bindings. */
  abstract addClaim(input: AddClaimInput): Promise<{ readonly claim: Claim; readonly deduplicated: boolean }>

  /** Record a verdict with its checks. */
  abstract setVerdict(
    claimId: string,
    verdict: Verdict,
    checks: readonly CheckResult[],
    options?: SetVerdictOptions,
  ): Promise<Claim>

  /** Re-run byte-level checks for one claim and record the verdict. */
  abstract verifyClaim(claimId: string): Promise<Claim>

  /** Read one snapshot with its bytes re-hashed. */
  abstract getSnapshot(snapshotId: HashRef): Promise<SnapshotView | undefined>

  /** Read one evidence item. */
  abstract getEvidence(evidenceId: string): Promise<Evidence | undefined>

  /** Read one claim with its latest verdict. */
  abstract getClaim(claimId: string): Promise<Claim | undefined>

  /** List every snapshot. */
  abstract listSnapshots(): Promise<readonly Snapshot[]>

  /** List every evidence item. */
  abstract listEvidence(): Promise<readonly Evidence[]>

  /** List every claim. */
  abstract listClaims(): Promise<readonly Claim[]>

  /** Aggregate counters. */
  abstract summarize(): Promise<ManifestSummary>

  /** Build an unsealed record view. */
  abstract buildRecord(options?: BuildRecordOptions): Promise<Omit<ResearchRecord, 'manifest'>>

  /** Seal the store into a `.rep.json` record with a sealed manifest. */
  abstract seal(options: SealOptions): Promise<SealResult>

  /** Verify a parsed record (re-hashes snapshots when a reader is available). */
  abstract verifyRecord(record: ResearchRecord, options?: VerifyRecordOptions): Promise<RecordVerification>

  /** Attach (or detach) the legacy research-report ledger to bridge against. */
  abstract attachReport(report: ReportServiceLike | undefined): void

  /** Import one legacy evidence snapshot into the REP store. */
  abstract importReportEvidence(evidenceId: string): Promise<Evidence>

  /** Mirror one REP evidence item into the legacy ledger, when attached. */
  abstract mirrorToReport(evidenceId: string): Promise<{ readonly id: string; readonly deduplicated: boolean }>
}
