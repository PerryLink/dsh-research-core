/**
 * Record verification — the part that needs the bytes.
 *
 * `validateRep` is pure: it cannot know whether a stored object still hashes to
 * its recorded address. `verifyRecord` reads every snapshot back, recomputes
 * the address, re-locates every quoted anchor, and re-checks the manifest seal.
 * A mismatch is a hard failure: the verifier never "repairs" a hash to make a
 * report pass.
 *
 * @module @perrylink/dsh-research-core/verify
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { verifyAuditChain } from './audit.ts'
import { normalizeText } from './claim.ts'
import { hashRefHex, sha256Hex } from './hash.ts'
import { verifyManifestSeal } from './manifest.ts'
import type { Evidence, HashRef, ResearchRecord, Snapshot, SnapshotMediaType } from './types.ts'
import { repErrors, validateRep, type ValidationIssue } from './validate.ts'

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
  for (const snapshot of record.snapshots) {
    if (!isTextualMediaType(snapshot.mediaType)) continue
    const bytes = await reader.read(snapshot.snapshotId)
    if (bytes === undefined) continue
    const text = decodeSnapshotText(bytes, snapshot.mediaType)
    if (text !== undefined) texts.set(snapshot.snapshotId, text)
  }
  return texts
}

/**
 * Re-hash every snapshot and re-locate every quoted anchor.
 * @param record - a parsed REP v1 record.
 * @param options - byte source and scope.
 * @returns the verification report.
 */
export async function verifyRecord(record: ResearchRecord, options: VerifyRecordOptions = {}): Promise<RecordVerification> {
  const issues: ValidationIssue[] = [...validateRep(record).issues]
  const reader = readerOf(options)
  const snapshots: SnapshotVerification[] = []
  const anchors: AnchorVerification[] = []

  if (reader !== undefined) {
    for (const [index, snapshot] of record.snapshots.entries()) {
      const bytes = await reader.read(snapshot.snapshotId)
      if (bytes === undefined) {
        snapshots.push({ snapshotId: snapshot.snapshotId, status: 'missing', recordedBytes: snapshot.bytes })
        issues.push({
          code: 'verify.snapshot_missing',
          path: `/snapshots/${index}`,
          message: `stored object for ${snapshot.snapshotId} is missing`,
          severity: 'error',
        })
        continue
      }
      const actual = sha256Hex(bytes)
      const expected = hashRefHex(snapshot.snapshotId)
      const fact: SnapshotVerification = {
        snapshotId: snapshot.snapshotId,
        status: actual === expected ? 'ok' : 'tampered',
        recordedBytes: snapshot.bytes,
        actualBytes: bytes.byteLength,
      }
      snapshots.push(fact)
      if (actual !== expected) {
        issues.push({
          code: 'verify.snapshot_hash_mismatch',
          path: `/snapshots/${index}`,
          message: `snapshot ${snapshot.snapshotId} re-hashes to sha256:${actual} — the record must not be trusted`,
          severity: 'error',
        })
      }
      if (bytes.byteLength !== snapshot.bytes) {
        issues.push({
          code: 'verify.snapshot_size_mismatch',
          path: `/snapshots/${index}`,
          message: `snapshot ${snapshot.snapshotId} is ${bytes.byteLength} bytes, record says ${snapshot.bytes}`,
          severity: 'error',
        })
      }
    }
  } else {
    for (const snapshot of record.snapshots) {
      snapshots.push({ snapshotId: snapshot.snapshotId, status: 'not_checked', recordedBytes: snapshot.bytes })
    }
  }

  if (options.verifyQuotes !== false && reader !== undefined) {
    const texts = await snapshotTexts(record, reader)
    for (const evidence of record.evidence) {
      for (const anchor of evidence.anchors) {
        if (anchor.quote === undefined || anchor.quote === '') continue
        const text = texts.get(anchor.snapshotId)
        const found = text !== undefined && normalizeText(text).includes(normalizeText(anchor.quote))
        anchors.push({
          evidenceId: evidence.evidenceId,
          snapshotId: anchor.snapshotId,
          value: anchor.value,
          quote: anchor.quote,
          found,
        })
        if (!found) {
          issues.push({
            code: 'verify.quote_not_found',
            path: `/evidence/${record.evidence.indexOf(evidence)}/anchors`,
            message: `quote for anchor ${anchor.value} of ${evidence.evidenceId} is not present verbatim in ${anchor.snapshotId}`,
            severity: 'error',
          })
        }
      }
    }
  }

  const manifestSeal: RecordVerification['manifestSeal'] =
    record.manifest === undefined ? undefined : verifyManifestSeal(record.manifest)

  const audit = record.audit
  if (audit !== undefined && audit.length > 0) {
    for (const defect of verifyAuditChain(audit)) {
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
    ...(typeof record.recordId === 'string' ? { recordId: record.recordId } : {}),
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
  const result = await verifyRecord(parsed as ResearchRecord, options)
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
