/**
 * The local, content-addressed REP store.
 *
 * Layout under the store root:
 * - `objects/<sha256>`        immutable snapshot bytes (written atomically, never overwritten)
 * - `snapshots.jsonl`         snapshot registrations (first registration wins per address)
 * - `evidence.jsonl`          evidence registrations
 * - `evidence-checks.jsonl`   evidence-level checks (latest line per evidence wins)
 * - `claims.jsonl`            claim registrations (immutable)
 * - `verdicts.jsonl`          claim verdicts with their checks (latest line per claim wins)
 * - `audits.jsonl`            append-only, hash-chained audit events
 * - `records/<id>.rep.json`   sealed REP records
 *
 * Reads re-hash every snapshot object before its bytes are returned, so a
 * tampered file is detected instead of trusted. Journals are append-only; a
 * corrupt journal line fails loud instead of being skipped.
 *
 * @module @perrylink/dsh-research-core/store
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { createAuditEvent } from './audit.ts'
import { claimInvariantViolations, evaluateClaim } from './claim.ts'
import { canonicalJson } from './canonical.ts'
import { hashRefHex, objectPathOf, sha256Hex, snapshotIdOf, stableId } from './hash.ts'
import { buildManifest, summarizeRecord, sealManifest } from './manifest.ts'
import type {
  Anchor,
  Artifact,
  AuditEvent,
  CheckResult,
  Claim,
  ClaimType,
  Evidence,
  Generator,
  HashRef,
  IsoTimestamp,
  ManifestSummary,
  Provenance,
  ResearchRecord,
  Snapshot,
  SnapshotMediaType,
  SourceRef,
  Verdict,
} from './types.ts'
import { validateRep } from './validate.ts'
import { evidenceTextsOf, isTextualMediaType } from './verify.ts'

/** The store's stable error codes. */
export type RepStoreErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_SNAPSHOT'
  | 'INVALID_EVIDENCE'
  | 'INVALID_CLAIM'
  | 'SNAPSHOT_MISSING'
  | 'SNAPSHOT_TOO_LARGE'
  | 'SNAPSHOT_TAMPERED'
  | 'EVIDENCE_UNKNOWN'
  | 'EVIDENCE_CONFLICT'
  | 'CLAIM_UNKNOWN'
  | 'CLAIM_CONFLICT'
  | 'RECORD_EXISTS'
  | 'LIMIT_EXCEEDED'
  | 'IO'

/** A store failure with a stable code. */
export class RepStoreError extends Error {
  /** The stable code. */
  readonly code: RepStoreErrorCode

  constructor(code: RepStoreErrorCode, message: string) {
    super(message)
    this.name = 'RepStoreError'
    this.code = code
  }
}

/** Options for {@link EvidenceStore}. */
export interface EvidenceStoreOptions {
  /** Hard cap on one snapshot's byte size (default 20 MiB). */
  readonly maxSnapshotBytes?: number
  /** Hard cap on registered evidence items (default 10 000). */
  readonly maxEvidence?: number
  /** Hard cap on registered claims (default 10 000). */
  readonly maxClaims?: number
  /** Clock override for deterministic tests. */
  readonly now?: () => Date
}

/** Input for {@link EvidenceStore.capture}. */
export interface CaptureInput {
  readonly bytes: Uint8Array | string
  readonly mediaType: SnapshotMediaType
  readonly sourceRef: SourceRef
  readonly capturedAt?: IsoTimestamp
  readonly encoding?: 'utf-8' | 'binary'
}

/** Result of {@link EvidenceStore.capture}. */
export interface CaptureResult {
  readonly snapshot: Snapshot
  /** True when the bytes were already stored under the same address. */
  readonly deduplicated: boolean
}

/** Input for {@link EvidenceStore.addEvidence}. */
export interface AddEvidenceInput {
  readonly evidenceId?: string
  readonly title?: string
  readonly sourceRef: SourceRef
  readonly snapshotIds: readonly HashRef[]
  readonly anchors: readonly Anchor[]
  readonly provenance: Provenance
  readonly checks?: readonly CheckResult[]
  readonly labels?: readonly string[]
  readonly notes?: string
}

/** Input for {@link EvidenceStore.addClaim}. */
export interface AddClaimInput {
  readonly claimId?: string
  readonly text: string
  readonly type: ClaimType
  readonly evidenceRefs: readonly string[]
  readonly locator?: Anchor
  readonly tolerance?: number
  readonly notes?: string
}

/** Options for {@link EvidenceStore.setVerdict}. */
export interface SetVerdictOptions {
  readonly note?: string
  readonly verdictAt?: IsoTimestamp
}

/** Input for {@link EvidenceStore.buildRecord}. */
export interface BuildRecordOptions {
  readonly recordId?: string
  readonly createdAt?: IsoTimestamp
  readonly generator?: Generator
  readonly artifacts?: readonly Artifact[]
  readonly notes?: readonly string[]
  /** Restrict the record to these evidence ids (default: all). */
  readonly evidenceIds?: readonly string[]
  /** Restrict the record to these claim ids (default: all). */
  readonly claimIds?: readonly string[]
}

/** Options for {@link EvidenceStore.seal}. */
export interface SealOptions extends BuildRecordOptions {
  readonly title: string
  readonly topic: string
  readonly generator: Generator
  readonly limitations?: readonly string[]
  /** Directory receiving the sealed record (default `<root>/records`). */
  readonly recordDir?: string
}

/** Result of {@link EvidenceStore.seal}. */
export interface SealResult {
  readonly record: ResearchRecord
  readonly manifest: NonNullable<ResearchRecord['manifest']>
  readonly recordPath: string
  /** SHA-256 of the exact record file bytes. */
  readonly recordHash: string
}

/** A snapshot plus its bytes and read-time integrity. */
export interface SnapshotView {
  readonly snapshot: Snapshot
  readonly bytes: Uint8Array
  readonly integrity: 'ok' | 'tampered'
}

/** One line of `evidence-checks.jsonl`. */
interface EvidenceChecksLine {
  readonly evidenceId: string
  readonly checks: readonly CheckResult[]
  readonly at: IsoTimestamp
}

/** One line of `verdicts.jsonl`. */
interface VerdictLine {
  readonly claimId: string
  readonly verdict: Verdict
  readonly checks: readonly CheckResult[]
  readonly at: IsoTimestamp
  readonly note?: string
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

/** Read one JSONL journal; a corrupt line fails loud with file and line. */
async function readJournal<T>(file: string): Promise<T[]> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw new RepStoreError('IO', `cannot read journal ${file}: ${(error as Error).message}`)
  }
  const lines = text.split('\n')
  const entries: T[] = []
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue
    try {
      entries.push(JSON.parse(line) as T)
    } catch (error) {
      throw new RepStoreError('IO', `corrupt journal ${file}:${index + 1}: ${(error as Error).message}`)
    }
  }
  return entries
}

/** Serialize one journal line. */
function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`
}

/**
 * The local REP store.
 *
 * Construction is synchronous and side-effect free; the journals and object
 * directory are loaded/created on first use (see {@link ready}).
 */
export class EvidenceStore {
  /** Absolute store root. */
  readonly root: string

  readonly #options: EvidenceStoreOptions
  readonly #snapshots = new Map<string, Snapshot>()
  readonly #evidence = new Map<string, Evidence>()
  readonly #evidenceChecks = new Map<string, readonly CheckResult[]>()
  readonly #claimRegistrations = new Map<string, Claim>()
  readonly #verdicts = new Map<string, VerdictLine>()
  #audits: AuditEvent[] = []
  #lastAuditHash: string | undefined
  #ready: Promise<void> | undefined
  #tail: Promise<unknown> = Promise.resolve()

  constructor(root: string, options: EvidenceStoreOptions = {}) {
    if (typeof root !== 'string' || root.trim() === '') throw new RepStoreError('INVALID_INPUT', 'store root must be a non-empty path')
    this.root = path.resolve(root)
    this.#options = options
  }

  /** Absolute path of the object directory. */
  get objectsDir(): string {
    return path.join(this.root, 'objects')
  }

  /** Absolute path of the sealed-record directory. */
  get recordsDir(): string {
    return path.join(this.root, 'records')
  }

  /** The clock in use (injectable for tests). */
  now(): Date {
    return this.#options.now?.() ?? new Date()
  }

  /** Current timestamp in REP form. */
  iso(): IsoTimestamp {
    return this.now().toISOString()
  }

  /** Load (and on first call create) every journal. Safe to call repeatedly. */
  ready(): Promise<void> {
    this.#ready ??= this.#load()
    return this.#ready
  }

  /** Run one write while holding the store's write lock. */
  async #locked<T>(body: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(body, body)
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Read every journal into memory and create the directory skeleton. */
  async #load(): Promise<void> {
    await mkdir(this.objectsDir, { recursive: true })
    await mkdir(this.recordsDir, { recursive: true })
    for (const snapshot of await readJournal<Snapshot>(path.join(this.root, 'snapshots.jsonl'))) {
      if (!this.#snapshots.has(snapshot.snapshotId)) this.#snapshots.set(snapshot.snapshotId, snapshot)
    }
    for (const evidence of await readJournal<Evidence>(path.join(this.root, 'evidence.jsonl'))) {
      this.#evidence.set(evidence.evidenceId, evidence)
    }
    for (const entry of await readJournal<EvidenceChecksLine>(path.join(this.root, 'evidence-checks.jsonl'))) {
      this.#evidenceChecks.set(entry.evidenceId, entry.checks)
    }
    for (const claim of await readJournal<Claim>(path.join(this.root, 'claims.jsonl'))) {
      this.#claimRegistrations.set(claim.claimId, { ...claim, checks: [] })
    }
    for (const verdict of await readJournal<VerdictLine>(path.join(this.root, 'verdicts.jsonl'))) {
      this.#verdicts.set(verdict.claimId, verdict)
    }
    this.#audits = await readJournal<AuditEvent>(path.join(this.root, 'audits.jsonl'))
    this.#lastAuditHash = this.#audits.at(-1)?.hash
  }

  /** Append one audit event to the chain (also in memory). */
  async #audit(type: string, payload: Record<string, unknown>): Promise<AuditEvent> {
    const event = createAuditEvent(
      {
        eventId: `evt-${String(this.#audits.length + 1).padStart(6, '0')}`,
        at: this.iso(),
        actor: 'plugin',
        type,
        payload,
        ...(this.#lastAuditHash === undefined ? {} : { prevHash: this.#lastAuditHash }),
      },
      () => this.now(),
    )
    await appendFile(path.join(this.root, 'audits.jsonl'), line(event), 'utf8')
    this.#audits.push(event)
    this.#lastAuditHash = event.hash
    return event
  }

  /** Append one JSON line to a journal. */
  async #append(name: string, value: unknown): Promise<void> {
    await appendFile(path.join(this.root, name), line(value), 'utf8')
  }

  /** Throw unless the stored object still hashes to its address. */
  async #assertObjectIntact(snapshotId: HashRef): Promise<void> {
    const target = path.join(this.objectsDir, hashRefHex(snapshotId))
    let existing: Buffer
    try {
      existing = await readFile(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new RepStoreError('SNAPSHOT_MISSING', `stored object ${target} is missing; re-capture or quarantine the store`)
      }
      throw error
    }
    if (sha256Hex(existing) !== hashRefHex(snapshotId)) {
      throw new RepStoreError(
        'SNAPSHOT_TAMPERED',
        `stored object ${target} does not hash to its address; refusing to treat it as the snapshot (quarantine the store and re-capture)`,
      )
    }
  }

  /** Write object bytes without ever overwriting a different object. */
  async #writeObject(snapshotId: HashRef, bytes: Uint8Array): Promise<void> {
    const target = path.join(this.objectsDir, hashRefHex(snapshotId))
    try {
      const existing = await readFile(target)
      if (sha256Hex(existing) === hashRefHex(snapshotId)) return
      throw new RepStoreError(
        'SNAPSHOT_TAMPERED',
        `stored object ${target} does not hash to its address; refusing to overwrite evidence (quarantine the store and re-capture)`,
      )
    } catch (error) {
      if (error instanceof RepStoreError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const temporary = path.join(this.objectsDir, `.${hashRefHex(snapshotId)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
    await writeFile(temporary, bytes)
    await rename(temporary, target)
  }

  /** Validate a probe record built from a subset of the store. */
  #assertProbe(parts: {
    snapshots: readonly Snapshot[]
    evidence: readonly Evidence[]
    claims: readonly Claim[]
    label: string
    code: 'INVALID_SNAPSHOT' | 'INVALID_EVIDENCE' | 'INVALID_CLAIM'
  }): void {
    const probe = {
      schemaVersion: 1 as const,
      recordId: 'rec-probe',
      createdAt: this.iso(),
      snapshots: parts.snapshots,
      evidence: parts.evidence,
      claims: parts.claims,
    }
    const result = validateRep(probe)
    if (!result.ok) {
      const first = result.issues.find(issue => issue.severity === 'error')
      throw new RepStoreError(parts.code, `${parts.label}: ${first?.code ?? 'invalid'} ${first?.message ?? ''}`)
    }
  }

  /** Assert one check's own invariants. */
  #assertCheck(check: CheckResult): void {
    if (typeof check.checkId !== 'string' || !ID_PATTERN.test(check.checkId)) {
      throw new RepStoreError('INVALID_INPUT', 'check.checkId must match the REP id pattern')
    }
    if (typeof check.detail !== 'string' || check.detail === '') {
      throw new RepStoreError('INVALID_INPUT', `check ${check.checkId}: detail must be a non-empty string`)
    }
    if (check.code === 'not_found' && check.status !== 'skipped') {
      throw new RepStoreError(
        'INVALID_INPUT',
        `check ${check.checkId}: code "not_found" must be recorded as status "skipped" (not_found is not a pass or a fail)`,
      )
    }
  }

  /**
   * Register snapshot bytes. Identical bytes are stored exactly once and the
   * same snapshot is returned.
   * @param input - bytes, media type and source.
   * @returns the snapshot and whether it was already known.
   */
  async capture(input: CaptureInput): Promise<CaptureResult> {
    await this.ready()
    return this.#locked(async () => {
      const bytes = typeof input.bytes === 'string' ? Buffer.from(input.bytes, 'utf8') : Buffer.from(input.bytes)
      const max = this.#options.maxSnapshotBytes ?? 20 * 1024 * 1024
      if (bytes.byteLength > max) {
        throw new RepStoreError('SNAPSHOT_TOO_LARGE', `snapshot is ${bytes.byteLength} bytes, cap is ${max}`)
      }
      const snapshotId = snapshotIdOf(bytes)
      const existing = this.#snapshots.get(snapshotId)
      if (existing !== undefined) {
        // Re-hash the stored object even on the dedupe path: a snapshot that is
        // already registered but whose bytes changed is tampering, not a hit.
        await this.#assertObjectIntact(snapshotId)
        return { snapshot: existing, deduplicated: true }
      }
      const snapshot: Snapshot = {
        snapshotId,
        mediaType: input.mediaType,
        bytes: bytes.byteLength,
        path: objectPathOf(snapshotId),
        capturedAt: input.capturedAt ?? this.iso(),
        sourceRef: input.sourceRef,
        encoding: input.encoding ?? (input.mediaType.startsWith('text/') || input.mediaType.includes('json') ? 'utf-8' : 'binary'),
      }
      this.#assertProbe({ snapshots: [snapshot], evidence: [], claims: [], label: 'snapshot', code: 'INVALID_SNAPSHOT' })
      await this.#writeObject(snapshotId, bytes)
      await this.#append('snapshots.jsonl', snapshot)
      this.#snapshots.set(snapshotId, snapshot)
      await this.#audit('snapshot.captured', {
        snapshotId,
        bytes: snapshot.bytes,
        mediaType: snapshot.mediaType,
        source: `${snapshot.sourceRef.kind}:${snapshot.sourceRef.id}`,
      })
      return { snapshot, deduplicated: false }
    })
  }

  /**
   * Register one evidence item. Every bound snapshot must already be stored and
   * every anchor must resolve inside it.
   * @param input - source, snapshots, anchors and provenance.
   * @returns the stored evidence.
   */
  async addEvidence(input: AddEvidenceInput): Promise<{ evidence: Evidence; deduplicated: boolean }> {
    await this.ready()
    return this.#locked(async () => {
      if (input.snapshotIds.length === 0) {
        throw new RepStoreError('INVALID_EVIDENCE', 'evidence without a snapshot is invalid by design')
      }
      const bound: Snapshot[] = []
      for (const snapshotId of input.snapshotIds) {
        const snapshot = this.#snapshots.get(snapshotId)
        if (snapshot === undefined) throw new RepStoreError('SNAPSHOT_MISSING', `snapshot ${snapshotId} is not stored`)
        bound.push(snapshot)
      }
      const evidenceId =
        input.evidenceId ?? stableId('ev', [input.sourceRef.kind, input.sourceRef.id, ...input.snapshotIds])
      if (!ID_PATTERN.test(evidenceId)) throw new RepStoreError('INVALID_INPUT', `invalid evidence id ${evidenceId}`)
      const evidence: Evidence = {
        evidenceId,
        ...(input.title === undefined ? {} : { title: input.title }),
        sourceRef: input.sourceRef,
        snapshotIds: input.snapshotIds,
        anchors: input.anchors,
        provenance: input.provenance,
        ...(input.checks === undefined ? {} : { checks: input.checks }),
        ...(input.labels === undefined ? {} : { labels: input.labels }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      }
      this.#assertProbe({ snapshots: bound, evidence: [evidence], claims: [], label: `evidence ${evidenceId}`, code: 'INVALID_EVIDENCE' })
      for (const check of evidence.checks ?? []) this.#assertCheck(check)
      if (this.#evidence.size >= (this.#options.maxEvidence ?? 10_000)) {
        throw new RepStoreError('LIMIT_EXCEEDED', 'evidence limit reached; seal or prune the store first')
      }
      const existing = this.#evidence.get(evidenceId)
      if (existing !== undefined) {
        if (canonicalJson(existing) !== canonicalJson(evidence)) {
          throw new RepStoreError('EVIDENCE_CONFLICT', `evidence ${evidenceId} is already registered with different content`)
        }
        return { evidence: existing, deduplicated: true }
      }
      await this.#append('evidence.jsonl', evidence)
      this.#evidence.set(evidenceId, evidence)
      await this.#audit('evidence.registered', {
        evidenceId,
        snapshotIds: evidence.snapshotIds,
        source: `${evidence.sourceRef.kind}:${evidence.sourceRef.id}`,
      })
      return { evidence, deduplicated: false }
    })
  }

  /**
   * Replace the checks recorded for one evidence item (latest wins).
   * @param evidenceId - the evidence to update.
   * @param checks - the complete new check set.
   * @returns the updated evidence.
   */
  async setEvidenceChecks(evidenceId: string, checks: readonly CheckResult[]): Promise<Evidence> {
    await this.ready()
    return this.#locked(async () => {
      const existing = this.#evidence.get(evidenceId)
      if (existing === undefined) throw new RepStoreError('EVIDENCE_UNKNOWN', `unknown evidence ${evidenceId}`)
      if (checks.length === 0) throw new RepStoreError('INVALID_INPUT', 'setEvidenceChecks requires at least one check')
      for (const check of checks) this.#assertCheck(check)
      const at = this.iso()
      await this.#append('evidence-checks.jsonl', { evidenceId, checks, at })
      this.#evidenceChecks.set(evidenceId, checks)
      await this.#audit('evidence.checks', {
        evidenceId,
        failed: checks.filter(check => check.status === 'fail').length,
        skipped: checks.filter(check => check.status === 'skipped').length,
      })
      return { ...existing, checks }
    })
  }

  /**
   * Register one claim (text + evidence bindings). Immutable once written.
   * @param input - the claim.
   * @returns the stored claim.
   */
  async addClaim(input: AddClaimInput): Promise<{ claim: Claim; deduplicated: boolean }> {
    await this.ready()
    return this.#locked(async () => {
      for (const ref of input.evidenceRefs) {
        if (!this.#evidence.has(ref)) throw new RepStoreError('EVIDENCE_UNKNOWN', `claim binds unknown evidence ${ref}`)
      }
      const claimId = input.claimId ?? stableId('cl', [input.text, input.evidenceRefs])
      if (!ID_PATTERN.test(claimId)) throw new RepStoreError('INVALID_INPUT', `invalid claim id ${claimId}`)
      const claim: Claim = {
        claimId,
        text: input.text,
        type: input.type,
        evidenceRefs: input.evidenceRefs,
        checks: [],
        ...(input.locator === undefined ? {} : { locator: input.locator }),
        ...(input.tolerance === undefined ? {} : { tolerance: input.tolerance }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      }
      const boundEvidence = input.evidenceRefs.map(ref => this.#evidence.get(ref)!)
      this.#assertProbe({
        snapshots: [...this.#snapshots.values()],
        evidence: boundEvidence,
        claims: [claim],
        label: `claim ${claimId}`,
        code: 'INVALID_CLAIM',
      })
      if (this.#claimRegistrations.size >= (this.#options.maxClaims ?? 10_000)) {
        throw new RepStoreError('LIMIT_EXCEEDED', 'claim limit reached; seal or prune the store first')
      }
      const existing = this.#claimRegistrations.get(claimId)
      if (existing !== undefined) {
        if (canonicalJson(existing) !== canonicalJson(claim)) {
          throw new RepStoreError('CLAIM_CONFLICT', `claim ${claimId} is already registered with different content`)
        }
        return { claim: this.getClaimFromState(claimId) ?? existing, deduplicated: true }
      }
      await this.#append('claims.jsonl', claim)
      this.#claimRegistrations.set(claimId, claim)
      await this.#audit('claim.registered', { claimId, evidenceRefs: claim.evidenceRefs, type: claim.type })
      return { claim, deduplicated: false }
    })
  }

  /**
   * Record a verdict and its checks for one claim (latest line wins).
   * @param claimId - the claim.
   * @param verdict - the verdict.
   * @param checks - at least one check explaining it.
   * @param options - optional note and timestamp.
   * @returns the merged claim.
   */
  async setVerdict(
    claimId: string,
    verdict: Verdict,
    checks: readonly CheckResult[],
    options: SetVerdictOptions = {},
  ): Promise<Claim> {
    await this.ready()
    return this.#locked(async () => {
      const registration = this.#claimRegistrations.get(claimId)
      if (registration === undefined) throw new RepStoreError('CLAIM_UNKNOWN', `unknown claim ${claimId}`)
      if (checks.length === 0) {
        throw new RepStoreError('INVALID_CLAIM', 'a claim with a verdict must carry at least one check')
      }
      for (const check of checks) this.#assertCheck(check)
      const at = options.verdictAt ?? this.iso()
      const merged: Claim = {
        ...registration,
        checks,
        verdict,
        verdictAt: at,
        ...(options.note === undefined ? {} : { notes: options.note }),
      }
      for (const violation of claimInvariantViolations(merged)) {
        throw new RepStoreError('INVALID_CLAIM', `claim ${claimId}: ${violation}`)
      }
      const boundEvidence = registration.evidenceRefs.map(ref => this.#evidence.get(ref))
      this.#assertProbe({
        snapshots: [...this.#snapshots.values()],
        evidence: boundEvidence.filter((item): item is Evidence => item !== undefined),
        claims: [merged],
        label: `verdict of claim ${claimId}`,
        code: 'INVALID_CLAIM',
      })
      const record: VerdictLine = {
        claimId,
        verdict,
        checks,
        at,
        ...(options.note === undefined ? {} : { note: options.note }),
      }
      await this.#append('verdicts.jsonl', record)
      this.#verdicts.set(claimId, record)
      await this.#audit('claim.verdict', {
        claimId,
        verdict,
        failed: checks.filter(check => check.status === 'fail').length,
        notFound: checks.filter(check => check.code === 'not_found').length,
      })
      return merged
    })
  }

  /**
   * Re-run the deterministic byte checks of one claim and record the verdict.
   * @param claimId - the claim to verify.
   * @returns the merged claim with fresh checks.
   */
  async verifyClaim(claimId: string): Promise<Claim> {
    await this.ready()
    const claim = this.getClaimFromState(claimId)
    if (claim === undefined) throw new RepStoreError('CLAIM_UNKNOWN', `unknown claim ${claimId}`)
    const bound = claim.evidenceRefs
      .map(ref => this.#evidence.get(ref))
      .filter((item): item is Evidence => item !== undefined)
    const texts = await evidenceTextsOf({ snapshots: [...this.#snapshots.values()] }, bound, this.reader())
    const anchors = bound.flatMap(evidence => evidence.anchors)
    const evaluation = evaluateClaim(claim, texts, anchors)
    return this.setVerdict(claimId, evaluation.verdict, evaluation.checks)
  }

  /** The store's own snapshot reader (re-hashes are done by callers). */
  reader(): { read: (snapshotId: HashRef) => Promise<Uint8Array | undefined> } {
    return {
      read: async (snapshotId: HashRef): Promise<Uint8Array | undefined> => {
        try {
          return await readFile(path.join(this.objectsDir, hashRefHex(snapshotId)))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw error
        }
      },
    }
  }

  /** Read one snapshot and re-hash its bytes. */
  async getSnapshot(snapshotId: HashRef): Promise<SnapshotView | undefined> {
    await this.ready()
    const snapshot = this.#snapshots.get(snapshotId)
    if (snapshot === undefined) return undefined
    const bytes = await this.reader().read(snapshotId)
    if (bytes === undefined) return undefined
    return { snapshot, bytes, integrity: sha256Hex(bytes) === hashRefHex(snapshotId) ? 'ok' : 'tampered' }
  }

  /** Read one evidence item (with its latest checks). */
  async getEvidence(evidenceId: string): Promise<Evidence | undefined> {
    await this.ready()
    const evidence = this.#evidence.get(evidenceId)
    if (evidence === undefined) return undefined
    const checks = this.#evidenceChecks.get(evidenceId)
    return checks === undefined ? evidence : { ...evidence, checks }
  }

  /** Read one claim with its latest verdict and checks. */
  async getClaim(claimId: string): Promise<Claim | undefined> {
    await this.ready()
    return this.getClaimFromState(claimId)
  }

  /** Every registered snapshot, in registration order. */
  async listSnapshots(): Promise<Snapshot[]> {
    await this.ready()
    return [...this.#snapshots.values()]
  }

  /** Every registered evidence item, in registration order. */
  async listEvidence(): Promise<Evidence[]> {
    await this.ready()
    return [...this.#evidence.keys()].map(id => this.evidenceFromState(id)!).filter(Boolean)
  }

  /** Every registered claim, in registration order. */
  async listClaims(): Promise<Claim[]> {
    await this.ready()
    return [...this.#claimRegistrations.keys()].map(id => this.getClaimFromState(id)!).filter(Boolean)
  }

  /** A snapshot of the store's counters. */
  async status(): Promise<ManifestSummary> {
    await this.ready()
    return summarizeRecord(await this.#stateRecord())
  }

  /** Merge one claim from in-memory state (no I/O). */
  private getClaimFromState(claimId: string): Claim | undefined {
    const registration = this.#claimRegistrations.get(claimId)
    if (registration === undefined) return undefined
    const verdict = this.#verdicts.get(claimId)
    if (verdict === undefined) return registration
    return {
      ...registration,
      checks: verdict.checks,
      verdict: verdict.verdict,
      verdictAt: verdict.at,
      ...(verdict.note === undefined ? {} : { notes: verdict.note }),
    }
  }

  /** Merge one evidence item from in-memory state. */
  private evidenceFromState(evidenceId: string): Evidence | undefined {
    const evidence = this.#evidence.get(evidenceId)
    if (evidence === undefined) return undefined
    const checks = this.#evidenceChecks.get(evidenceId)
    return checks === undefined ? evidence : { ...evidence, checks }
  }

  /** Build the in-memory record view (no manifest). */
  async #stateRecord(options: BuildRecordOptions = {}): Promise<Omit<ResearchRecord, 'manifest'>> {
    const evidenceFilter = options.evidenceIds === undefined ? undefined : new Set(options.evidenceIds)
    const claimFilter = options.claimIds === undefined ? undefined : new Set(options.claimIds)
    const evidence = [...this.#evidence.keys()]
      .filter(id => evidenceFilter === undefined || evidenceFilter.has(id))
      .map(id => this.evidenceFromState(id)!)
    const claims = [...this.#claimRegistrations.keys()]
      .filter(id => claimFilter === undefined || claimFilter.has(id))
      .map(id => this.getClaimFromState(id)!)
    const usedSnapshots = new Set<string>()
    for (const item of evidence) {
      for (const snapshotId of item.snapshotIds) usedSnapshots.add(snapshotId)
      for (const anchor of item.anchors) usedSnapshots.add(anchor.snapshotId)
    }
    for (const claim of claims) {
      if (claim.locator !== undefined) usedSnapshots.add(claim.locator.snapshotId)
      for (const check of claim.checks) {
        if (check.locator !== undefined) usedSnapshots.add(check.locator.snapshotId)
      }
    }
    const snapshots =
      options.evidenceIds === undefined && options.claimIds === undefined
        ? [...this.#snapshots.values()]
        : [...this.#snapshots.values()].filter(snapshot => usedSnapshots.has(snapshot.snapshotId))
    const createdAt = options.createdAt ?? this.iso()
    return {
      schemaVersion: 1,
      recordId: options.recordId ?? stableId('rec', [createdAt, evidence.length, claims.length]),
      createdAt,
      ...(options.generator === undefined ? {} : { generator: options.generator }),
      snapshots,
      evidence,
      claims,
      ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
      ...(this.#audits.length === 0 ? {} : { audit: [...this.#audits] }),
      ...(options.notes === undefined ? {} : { notes: options.notes }),
    }
  }

  /**
   * Build an unsealed REP record from the store.
   * @param options - filtering and identity.
   * @returns the record (no manifest).
   */
  async buildRecord(options: BuildRecordOptions = {}): Promise<Omit<ResearchRecord, 'manifest'>> {
    await this.ready()
    return this.#stateRecord(options)
  }

  /**
   * Seal the store into a `.rep.json` record with a sealed manifest.
   * @param options - report identity and filtering.
   * @returns the sealed record, manifest, path and file hash.
   */
  async seal(options: SealOptions): Promise<SealResult> {
    await this.ready()
    return this.#locked(async () => {
      const createdAt = options.createdAt ?? this.iso()
      const recordId = options.recordId ?? stableId('rec', [options.title, options.topic, createdAt])
      if (!ID_PATTERN.test(recordId)) throw new RepStoreError('INVALID_INPUT', `invalid record id ${recordId}`)
      await this.#audit('report.sealing', { recordId, title: options.title, topic: options.topic })
      const base = await this.#stateRecord({ ...options, recordId, createdAt })
      const recordFile = `${recordId}.rep.json`
      const manifest = sealManifest(
        buildManifest(base, {
          title: options.title,
          topic: options.topic,
          generator: options.generator,
          generatedAt: createdAt,
          recordFile,
          ...(options.limitations === undefined ? {} : { limitations: options.limitations }),
        }),
        createdAt,
      )
      const record: ResearchRecord = { ...base, manifest }
      const validation = validateRep(record)
      if (!validation.ok) {
        const first = validation.issues.find(issue => issue.severity === 'error')
        throw new RepStoreError('INVALID_INPUT', `sealed record would be invalid: ${first?.code ?? 'unknown'} ${first?.message ?? ''}`)
      }
      const recordDir = options.recordDir === undefined ? this.recordsDir : path.resolve(options.recordDir)
      await mkdir(recordDir, { recursive: true })
      const recordPath = path.join(recordDir, recordFile)
      try {
        await readFile(recordPath)
        throw new RepStoreError('RECORD_EXISTS', `refusing to overwrite the sealed record ${recordPath}`)
      } catch (error) {
        if (error instanceof RepStoreError) throw error
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const text = `${JSON.stringify(record, null, 2)}\n`
      const recordHash = sha256Hex(text)
      await writeFile(recordPath, text, 'utf8')
      await this.#audit('report.sealed', {
        recordId,
        manifestId: manifest.manifestId,
        manifestHash: manifest.integrity?.manifestHash ?? '',
        recordHash,
      })
      return { record, manifest, recordPath, recordHash }
    })
  }
}

/**
 * Decode a snapshot's text when its media type is textual.
 * @param view - a snapshot view.
 * @returns the text, or undefined for binary media.
 */
export function snapshotTextOf(view: SnapshotView): string | undefined {
  if (!isTextualMediaType(view.snapshot.mediaType)) return undefined
  return Buffer.from(view.bytes).toString('utf8')
}
