/**
 * The local REP Provider: registers `ctx.researchEvidence` on the mounting
 * fiber and backs it with an {@link EvidenceStore}.
 *
 * The bridge to `dsh-research-report` is structural and optional: the host
 * passes `ctx.get('researchReport')` when that plugin is mounted, and core can
 * then import legacy evidence into REP (or mirror REP evidence back). Neither
 * package imports the other.
 *
 * @module @perrylink/dsh-research-core/provider-local
 */

import type { Context } from '@deepseek-ai/cordis'
import { stableId } from './hash.ts'
import { ResearchEvidenceService, type ReportServiceLike } from './service.ts'
import {
  EvidenceStore,
  RepStoreError,
  snapshotTextOf,
  type AddClaimInput,
  type AddEvidenceInput,
  type BuildRecordOptions,
  type CaptureInput,
  type CaptureResult,
  type SealOptions,
  type SealResult,
  type SetVerdictOptions,
  type SnapshotView,
} from './store.ts'
import type { ResolvedConfig } from './config.ts'
import type {
  CheckResult,
  Claim,
  Evidence,
  HashRef,
  ManifestSummary,
  ResearchRecord,
  Snapshot,
  SourceRef,
  Verdict,
} from './types.ts'
import { verifyRecord, verifyRecordFile, type RecordVerification, type VerifyRecordOptions } from './verify.ts'
import { VERSION } from './version.ts'

/** The local REP provider mounted by the plugin. */
export class LocalResearchEvidenceService extends ResearchEvidenceService {
  /** The backing store (exposed for tooling and tests). */
  readonly store: EvidenceStore

  private readonly resolved: ResolvedConfig
  private reportService: ReportServiceLike | undefined

  /**
   * @param ctx - the plugin context (the service is registered on it).
   * @param config - the fully resolved plugin config.
   */
  constructor(ctx: Context, config: ResolvedConfig) {
    super(ctx)
    this.resolved = config
    this.store = new EvidenceStore(config.root, {
      maxSnapshotBytes: config.maxSnapshotBytes,
      maxEvidence: config.maxEvidence,
      maxClaims: config.maxClaims,
    })
  }

  /** The resolved config (read-only). */
  get config(): ResolvedConfig {
    return this.resolved
  }

  /** Capture snapshot bytes. */
  async capture(input: CaptureInput): Promise<CaptureResult> {
    return this.store.capture(input)
  }

  /** Register evidence bound to stored snapshots. */
  async addEvidence(input: AddEvidenceInput): Promise<{ evidence: Evidence; deduplicated: boolean }> {
    return this.store.addEvidence(input)
  }

  /** Replace the checks recorded for one evidence item. */
  async setEvidenceChecks(evidenceId: string, checks: readonly CheckResult[]): Promise<Evidence> {
    return this.store.setEvidenceChecks(evidenceId, checks)
  }

  /** Register a claim. */
  async addClaim(input: AddClaimInput): Promise<{ claim: Claim; deduplicated: boolean }> {
    return this.store.addClaim(input)
  }

  /** Record a verdict. */
  async setVerdict(
    claimId: string,
    verdict: Verdict,
    checks: readonly CheckResult[],
    options?: SetVerdictOptions,
  ): Promise<Claim> {
    return this.store.setVerdict(claimId, verdict, checks, options)
  }

  /** Re-run the deterministic byte checks and record the verdict. */
  async verifyClaim(claimId: string): Promise<Claim> {
    return this.store.verifyClaim(claimId)
  }

  /** Read a snapshot with its bytes re-hashed. */
  async getSnapshot(snapshotId: HashRef): Promise<SnapshotView | undefined> {
    return this.store.getSnapshot(snapshotId)
  }

  /** Read one evidence item. */
  async getEvidence(evidenceId: string): Promise<Evidence | undefined> {
    return this.store.getEvidence(evidenceId)
  }

  /** Read one claim. */
  async getClaim(claimId: string): Promise<Claim | undefined> {
    return this.store.getClaim(claimId)
  }

  /** List snapshots. */
  async listSnapshots(): Promise<readonly Snapshot[]> {
    return this.store.listSnapshots()
  }

  /** List evidence. */
  async listEvidence(): Promise<readonly Evidence[]> {
    return this.store.listEvidence()
  }

  /** List claims. */
  async listClaims(): Promise<readonly Claim[]> {
    return this.store.listClaims()
  }

  /** Aggregate counters. */
  async summarize(): Promise<ManifestSummary> {
    return this.store.status()
  }

  /** Build an unsealed record view. */
  async buildRecord(options: BuildRecordOptions = {}): Promise<Omit<ResearchRecord, 'manifest'>> {
    return this.store.buildRecord(options)
  }

  /** Seal the store into a `.rep.json` record. */
  async seal(options: SealOptions): Promise<SealResult> {
    return this.store.seal(options)
  }

  /** Verify a parsed record, defaulting the byte source to this store. */
  async verifyRecord(record: ResearchRecord, options: VerifyRecordOptions = {}): Promise<RecordVerification> {
    return verifyRecord(record, { ...options, objectsDir: options.objectsDir ?? this.store.objectsDir })
  }

  /** Verify a record file, defaulting the byte source to this store. */
  async verifyRecordFile(
    file: string,
    options: VerifyRecordOptions = {},
  ): Promise<RecordVerification & { readonly fileHash: string }> {
    return verifyRecordFile(file, { ...options, objectsDir: options.objectsDir ?? this.store.objectsDir })
  }

  /** Attach or detach the legacy `dsh-research-report` ledger. */
  attachReport(report: ReportServiceLike | undefined): void {
    this.reportService = report
  }

  /** The attached legacy ledger, when any. */
  get report(): ReportServiceLike | undefined {
    return this.reportService
  }

  /**
   * Import one `dsh-research-report` snapshot into the REP store.
   *
   * The imported evidence records an integrity check: a legacy snapshot that
   * no longer matches its hash is imported as `fail`, never silently accepted.
   * @param evidenceId - the legacy ledger id.
   * @returns the REP evidence item.
   */
  async importReportEvidence(evidenceId: string): Promise<Evidence> {
    const report = this.reportService
    if (report === undefined) {
      throw new RepStoreError('INVALID_INPUT', 'no ctx.researchReport is attached; mount dsh-research-report or pass inline content instead')
    }
    const record = await report.getEvidence(evidenceId)
    if (record === undefined) throw new RepStoreError('EVIDENCE_UNKNOWN', `research-report has no evidence ${evidenceId}`)
    const content = await report.readEvidenceContent(evidenceId)
    if (content === undefined) throw new RepStoreError('EVIDENCE_UNKNOWN', `research-report cannot read evidence ${evidenceId}`)
    const sourceRef: SourceRef = {
      kind: 'other',
      id: `research-report:${evidenceId}`,
      retrievedAt: record.capturedAt,
      metadata: { title: record.title },
    }
    const captured = await this.store.capture({
      bytes: content.content,
      mediaType: 'text/plain',
      sourceRef,
      capturedAt: record.capturedAt,
    })
    const checks: CheckResult[] =
      content.integrity === 'ok'
        ? [
            {
              checkId: stableId('chk', ['import', evidenceId, 'integrity']),
              check: 'source-status',
              status: 'pass',
              detail: `imported from dsh-research-report evidence ${evidenceId}; bytes re-hash to the recorded address`,
            },
          ]
        : [
            {
              checkId: stableId('chk', ['import', evidenceId, 'integrity']),
              check: 'source-status',
              status: 'fail',
              code: 'integrity_mismatch',
              severity: 'error',
              detail: `dsh-research-report reports the snapshot as ${content.integrity}; the import is marked failed, not repaired`,
            },
          ]
    const { evidence } = await this.store.addEvidence({
      evidenceId: stableId('ev', ['research-report', evidenceId, captured.snapshot.snapshotId]),
      title: record.title,
      sourceRef,
      snapshotIds: [captured.snapshot.snapshotId],
      anchors: [{ snapshotId: captured.snapshot.snapshotId, kind: 'record', value: 'field:content' }],
      provenance: {
        plugin: '@perrylink/dsh-research-core',
        version: VERSION,
        method: `import of dsh-research-report evidence ${evidenceId}`,
        retrievedAt: this.store.iso(),
        inputHash: record.hash,
      },
      checks,
    })
    return evidence
  }

  /**
   * Mirror one REP evidence item into the attached legacy ledger.
   * @param evidenceId - the REP evidence id.
   * @returns the legacy record id and whether it already existed.
   */
  async mirrorToReport(evidenceId: string): Promise<{ id: string; deduplicated: boolean }> {
    const report = this.reportService
    if (report === undefined) {
      throw new RepStoreError('INVALID_INPUT', 'no ctx.researchReport is attached; nothing to mirror into')
    }
    const evidence = await this.store.getEvidence(evidenceId)
    if (evidence === undefined) throw new RepStoreError('EVIDENCE_UNKNOWN', `unknown evidence ${evidenceId}`)
    let text: string | undefined
    for (const snapshotId of evidence.snapshotIds) {
      const view = await this.store.getSnapshot(snapshotId)
      if (view === undefined) continue
      text = snapshotTextOf(view)
      if (text !== undefined) break
    }
    if (text === undefined) {
      throw new RepStoreError('INVALID_INPUT', 'mirrorToReport needs at least one textual snapshot')
    }
    const result = await report.addEvidence({
      id: evidenceId,
      title: evidence.title ?? `${evidence.sourceRef.kind}:${evidence.sourceRef.id}`,
      origin: `${evidence.sourceRef.kind}:${evidence.sourceRef.id}`,
      content: text,
      capturedAt: evidence.provenance.retrievedAt,
    })
    return { id: result.record.id, deduplicated: result.deduplicated }
  }
}
