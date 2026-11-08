/**
 * Record verification — the part that needs the bytes.
 *
 * `validateRep` is pure: it cannot know whether a stored object still hashes to
 * its recorded address. `verifyRecord` reads every snapshot back, recomputes
 * the address, re-locates every quoted evidence anchor, and re-checks the manifest seal.
 * A mismatch is a hard failure: the verifier never "repairs" a hash to make a
 * report pass.
 *
 * @module @perrylink/dsh-research-core/verify
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { verifyAuditChain } from './audit.ts'
import { normalizeText } from './claim.ts'
import { hashRefHex, isHashRef, sha256Hex } from './hash.ts'
import { verifyManifestSeal } from './manifest.ts'
import type { AuditEvent, Evidence, HashRef, ReportManifest, ResearchRecord, Snapshot, SnapshotMediaType } from './types.ts'
import { repErrors, validateRep, type ValidationIssue } from './validate.ts'

/** True for a plain non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Something that can return the stored bytes of a snapshot. */
export interface SnapshotReader {
  /**
   * Read the bytes of one snapshot.
   * @param snapshotId - the content address.
   * @returns the bytes, or undefined when the object is missing.
   */
  read(snapshotId: HashRef): Promise<Uint8Array | undefined>
}

/** Media types whose bytes are decoded as UTF-8 text. */
const TEXTUAL: ReadonlySet<SnapshotMediaType> = new Set<SnapshotMediaType>([
  'text/html',
  'text/x-latex',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/x-ndjson',
  'application/x-bibtex',
  'application/xml',
  'text/xml',
])

/**
 * Whether a snapshot's bytes can be decoded as text for quote/number checks.
 * @param mediaType - the snapshot media type.
 * @returns true for textual media types.
 */
export function isTextualMediaType(mediaType: SnapshotMediaType): boolean {
  return TEXTUAL.has(mediaType)
}

/**
 * Read the stored snapshot text when the media type is textual.
 * @param bytes - the stored bytes.
 * @param mediaType - the snapshot media type.
 * @returns the decoded text, or undefined for binary media.
 */
export function decodeSnapshotText(bytes: Uint8Array, mediaType: SnapshotMediaType): string | undefined {
  if (!isTextualMediaType(mediaType)) return undefined
  return Buffer.from(bytes).toString('utf8')
}

/**
 * A snapshot reader backed by a content-addressed `objects/` directory.
 * @param objectsDir - absolute path of the objects directory.
 * @returns the reader.
 */
export function fileSnapshotReader(objectsDir: string): SnapshotReader {
  const root = path.resolve(objectsDir)
  return {
    async read(snapshotId: HashRef): Promise<Uint8Array | undefined> {
      try {
        return await readFile(path.join(root, hashRefHex(snapshotId)))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    },
  }
}

/** Per-snapshot verification outcome. */
export interface SnapshotVerification {
  readonly snapshotId: HashRef
  readonly status: 'ok' | 'tampered' | 'missing' | 'not_checked'
  readonly recordedBytes: number
  readonly actualBytes?: number
}

/** A locator that could not be re-found in its snapshot. */
export interface AnchorVerification {
  readonly evidenceId: string
  readonly snapshotId: HashRef
  readonly value: string
  readonly quote: string
  readonly found: boolean
}

/** The complete verification report of one record. */
export interface RecordVerification {
  /** True when nothing failed. */
  readonly ok: boolean
  /** The record id, when readable. */
  readonly recordId?: string
  /** The seal comparison, when the record carries a manifest. */
  readonly manifestSeal?: { readonly ok: boolean; readonly expected: string; readonly recorded?: string }
  /** Per-snapshot integrity (empty when no reader was supplied). */
  readonly snapshots: readonly SnapshotVerification[]
  /** Quote anchors that could not be re-located. */
  readonly anchors: readonly AnchorVerification[]
  /** Validation and verification issues (errors fail the run). */
  readonly issues: readonly ValidationIssue[]
}

/** Options for {@link verifyRecord}. */
export interface VerifyRecordOptions {
  /** A snapshot byte source. Without one, hashes are `not_checked`. */
  readonly reader?: SnapshotReader
  /** Convenience: build a file reader over this `objects/` directory. */
  readonly objectsDir?: string
  /** Check verbatim quote anchors against decoded snapshot text (default true). */
  readonly verifyQuotes?: boolean
}

/** Resolve the reader from options. */
function readerOf(options: VerifyRecordOptions): SnapshotReader | undefined {
  if (options.reader !== undefined) return options.reader
  if (options.objectsDir !== undefined) return fileSnapshotReader(options.objectsDir)
  return undefined
}

/** Decode textual snapshots into a map for quote checks. */
async function snapshotTexts(
  record: ResearchRecord,
  reader: SnapshotReader,
): Promise<Map<string, string>> {
  const texts = new Map<string, string>()
  for (const raw of Array.isArray(record.snapshots) ? record.snapshots : []) {
    if (!isRecord(raw) || !isHashRef(raw['snapshotId']) || typeof raw['mediaType'] !== 'string') continue
    const mediaType = raw['mediaType'] as SnapshotMediaType
    if (!isTextualMediaType(mediaType)) continue
    const bytes = await reader.read(raw['snapshotId'])
    if (bytes === undefined) continue
    const text = decodeSnapshotText(bytes, mediaType)
    if (text !== undefined) texts.set(raw['snapshotId'], text)
  }
  return texts
}

/** Whether a quote occurs verbatim (after normalization) in a decoded text. */
function quoteIn(text: string | undefined, quote: string): boolean {
  return text !== undefined && normalizeText(text).includes(normalizeText(quote))
}

/**
 * Re-hash every snapshot and re-locate every quoted evidence anchor.
 *
 * The input is typed as `unknown` on purpose: this is the read boundary for
 * untrusted `.rep.json` files, so malformed shapes become failed verification
 * issues rather than exceptions.
 * @param record - a parsed REP v1 record.
 * @param options - byte source and scope.
 * @returns the verification report.
 */
export async function verifyRecord(record: unknown, options: VerifyRecordOptions = {}): Promise<RecordVerification> {
  const issues: ValidationIssue[] = [...validateRep(record).issues]
  const reader = readerOf(options)
  const snapshots: SnapshotVerification[] = []
  const anchors: AnchorVerification[] = []

  if (
    !isRecord(record) ||
    !Array.isArray(record['snapshots']) ||
    !Array.isArray(record['evidence']) ||
    !Array.isArray(record['claims'])
  ) {
    // validateRep already reported record.not_object / record.field_type; there
    // is nothing addressable to re-hash or re-locate.
    return { ok: false, snapshots, anchors, issues }
  }
  const doc = record as unknown as ResearchRecord

  if (reader !== undefined) {
    for (const [index, raw] of doc.snapshots.entries()) {
      if (!isRecord(raw) || !isHashRef(raw['snapshotId'])) continue
      const snapshotId = raw['snapshotId']
      const recordedBytes = typeof raw['bytes'] === 'number' ? raw['bytes'] : 0
      const bytes = await reader.read(snapshotId)
      if (bytes === undefined) {
        snapshots.push({ snapshotId, status: 'missing', recordedBytes })
        issues.push({
          code: 'verify.snapshot_missing',
          path: `/snapshots/${index}`,
          message: `stored object for ${snapshotId} is missing`,
          severity: 'error',
        })
        continue
      }
      const actual = sha256Hex(bytes)
      const expected = hashRefHex(snapshotId)
      const fact: SnapshotVerification = {
        snapshotId,
        status: actual === expected ? 'ok' : 'tampered',
        recordedBytes,
        actualBytes: bytes.byteLength,
      }
      snapshots.push(fact)
      if (actual !== expected) {
        issues.push({
          code: 'verify.snapshot_hash_mismatch',
          path: `/snapshots/${index}`,
          message: `snapshot ${snapshotId} re-hashes to sha256:${actual} — the record must not be trusted`,
          severity: 'error',
        })
      }
      if (typeof raw['bytes'] === 'number' && bytes.byteLength !== raw['bytes']) {
        issues.push({
          code: 'verify.snapshot_size_mismatch',
          path: `/snapshots/${index}`,
          message: `snapshot ${snapshotId} is ${bytes.byteLength} bytes, record says ${String(raw['bytes'])}`,
          severity: 'error',
        })
      }
    }
  } else {
    for (const raw of doc.snapshots) {
      if (!isRecord(raw) || !isHashRef(raw['snapshotId'])) continue
      snapshots.push({
        snapshotId: raw['snapshotId'],
        status: 'not_checked',
        recordedBytes: typeof raw['bytes'] === 'number' ? raw['bytes'] : 0,
      })
    }
  }

  if (options.verifyQuotes !== false && reader !== undefined) {
    const texts = await snapshotTexts(doc, reader)
    for (const [evidenceIndex, rawEvidence] of doc.evidence.entries()) {
      if (!isRecord(rawEvidence) || !Array.isArray(rawEvidence['anchors'])) continue
      const evidenceId = typeof rawEvidence['evidenceId'] === 'string' ? rawEvidence['evidenceId'] : `evidence[${evidenceIndex}]`
      for (const rawAnchor of rawEvidence['anchors']) {
        if (!isRecord(rawAnchor)) continue
        const quote = rawAnchor['quote']
        const snapshotId = rawAnchor['snapshotId']
        if (typeof quote !== 'string' || quote === '' || !isHashRef(snapshotId)) continue
        const value = typeof rawAnchor['value'] === 'string' ? rawAnchor['value'] : ''
        const found = quoteIn(texts.get(snapshotId), quote)
        anchors.push({ evidenceId, snapshotId, value, quote, found })
        if (!found) {
          issues.push({
            code: 'verify.quote_not_found',
            path: `/evidence/${evidenceIndex}/anchors`,
            message: `quote for anchor ${value} of ${evidenceId} is not present verbatim in ${snapshotId}`,
            severity: 'error',
          })
        }
      }
    }
  }

  let manifestSeal: RecordVerification['manifestSeal']
  if (isRecord(doc.manifest)) {
    try {
      manifestSeal = verifyManifestSeal(doc.manifest as unknown as ReportManifest)
    } catch {
      // validateRep reports the uncomputable seal; keep the verification report
      // honest instead of throwing on a hostile manifest.
      manifestSeal = { ok: false, expected: '(uncomputable)' }
    }
  }

  const audit = doc.audit
  if (Array.isArray(audit) && audit.length > 0) {
    for (const defect of verifyAuditChain(audit as unknown as AuditEvent[])) {
      if (defect.code === 'event.duplicate_id') continue
      issues.push({
        code: 'verify.audit_chain',
        path: `/audit/${defect.index}`,
        message: defect.message,
        severity: 'error',
      })
    }
  }

  return {
    ok: repErrors({ ok: false, issues }).length === 0,
    ...(typeof doc.recordId === 'string' ? { recordId: doc.recordId } : {}),
    ...(manifestSeal === undefined ? {} : { manifestSeal }),
    snapshots,
    anchors,
    issues,
  }
}

/**
 * Verify a record file: read it, hash the exact bytes, verify its content.
 * @param file - path of a `.rep.json` record.
 * @param options - byte source and scope.
 * @returns the verification report plus the file hash.
 */
export async function verifyRecordFile(
  file: string,
  options: VerifyRecordOptions = {},
): Promise<RecordVerification & { readonly fileHash: string }> {
  const bytes = await readFile(file)
  const fileHash = sha256Hex(bytes)
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    return {
      ok: false,
      fileHash,
      snapshots: [],
      anchors: [],
      issues: [
        {
          code: 'record.not_json',
          path: '',
          message: `record file is not valid JSON: ${(error as Error).message}`,
          severity: 'error',
        },
      ],
    }
  }
  const result = await verifyRecord(parsed, options)
  return { ...result, fileHash }
}

/**
 * Resolve the evidence records a claim binds, with their text (used by the
 * store's `verifyClaim`).
 * @param record - the record providing snapshots.
 * @param evidence - the evidence items to reduce.
 * @param reader - the byte source.
 * @returns one entry per evidence, with decoded text.
 */
export async function evidenceTextsOf(
  record: Pick<ResearchRecord, 'snapshots'>,
  evidence: readonly Evidence[],
  reader: SnapshotReader,
): Promise<Array<{ evidenceId: string; texts: string[]; integrity: 'ok' | 'tampered' | 'missing' | 'unknown'; binaryOnly: boolean }>> {
  const byId = new Map<string, Snapshot>()
  for (const snapshot of record.snapshots) byId.set(snapshot.snapshotId, snapshot)
  const result: Array<{ evidenceId: string; texts: string[]; integrity: 'ok' | 'tampered' | 'missing' | 'unknown'; binaryOnly: boolean }> = []
  for (const item of evidence) {
    const texts: string[] = []
    let integrity: 'ok' | 'tampered' | 'missing' | 'unknown' = 'ok'
    let textual = false
    for (const snapshotId of item.snapshotIds) {
      const snapshot = byId.get(snapshotId)
      if (snapshot === undefined) {
        integrity = 'missing'
        continue
      }
      const bytes = await reader.read(snapshotId)
      if (bytes === undefined) {
        integrity = integrity === 'ok' ? 'missing' : integrity
        continue
      }
      if (sha256Hex(bytes) !== hashRefHex(snapshotId)) {
        integrity = 'tampered'
        continue
      }
      const text = decodeSnapshotText(bytes, snapshot.mediaType)
      if (text !== undefined) {
        textual = true
        texts.push(text)
      }
    }
    result.push({ evidenceId: item.evidenceId, texts, integrity, binaryOnly: !textual })
  }
  return result
}
