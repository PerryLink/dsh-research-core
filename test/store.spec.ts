/**
 * The local store: content addressing, journals, verdicts, sealing — and the
 * two rules that matter most: a tampered object is detected, and a verdict can
 * never be recorded without a check.
 * @module test/store.spec
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hashRefHex } from '../src/hash.ts'
import { getRepSchema } from '../src/schema.ts'
import { EvidenceStore, RepStoreError } from '../src/store.ts'
import type { CheckResult, HashRef } from '../src/types.ts'
import { validateRep } from '../src/validate.ts'
import { verifyRecord } from '../src/verify.ts'

const AT = '2026-01-15T10:00:00.000Z'
const TEXT = [
  'Synthetic fixture article.',
  'In this fixture the treatment group improved (t(28) = 2.50, p = .018), with d = 0.45.',
  'The effect size was moderate.',
].join('\n')
const QUOTE = 'the treatment group improved (t(28) = 2.50, p = .018)'
const GENERATOR = { name: 'store-test', version: '1.0.0' }

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'rep-store-'))
})

afterEach(async () => {
  // Only ever remove our own mkdtemp directory inside the OS temp dir.
  if (root.startsWith(tmpdir())) await rm(root, { recursive: true, force: true })
})

/** Build a store with a frozen clock. */
function makeStore(options: { maxSnapshotBytes?: number } = {}): EvidenceStore {
  return new EvidenceStore(root, {
    ...options,
    now: () => new Date(AT),
  })
}

/** Capture the article and register evidence + one claim. */
async function seed(store: EvidenceStore): Promise<{ evidenceId: string; claimId: string; snapshotId: string }> {
  const { snapshot } = await store.capture({
    bytes: TEXT,
    mediaType: 'text/plain',
    sourceRef: { kind: 'file', id: 'fixtures/article.txt', retrievedAt: AT },
  })
  const { evidence } = await store.addEvidence({
    evidenceId: 'ev-test-article',
    title: 'Synthetic article',
    sourceRef: { kind: 'file', id: 'fixtures/article.txt', retrievedAt: AT },
    snapshotIds: [snapshot.snapshotId],
    anchors: [
      {
        snapshotId: snapshot.snapshotId,
        kind: 'char',
        value: 'c.52-119',
        charRange: { start: 52, end: 119 },
        quote: QUOTE,
      },
    ],
    provenance: { plugin: 'test', version: '1.0.0', method: 'unit test', retrievedAt: AT },
  })
  const { claim } = await store.addClaim({
    claimId: 'cl-test-verified',
    text: 'The trial reports t(28) = 2.50 with p = .018.',
    type: 'result',
    evidenceRefs: [evidence.evidenceId],
    locator: {
      snapshotId: snapshot.snapshotId,
      kind: 'char',
      value: 'c.52-119',
      charRange: { start: 52, end: 119 },
      quote: QUOTE,
    },
  })
  return { evidenceId: evidence.evidenceId, claimId: claim.claimId, snapshotId: snapshot.snapshotId }
}

describe('capture', () => {
  it('stores content-addressed objects and dedupes identical bytes', async () => {
    const store = makeStore()
    const first = await store.capture({
      bytes: 'hello',
      mediaType: 'text/plain',
      sourceRef: { kind: 'file', id: 'a.txt', retrievedAt: AT },
    })
    const second = await store.capture({
      bytes: 'hello',
      mediaType: 'text/plain',
      sourceRef: { kind: 'url', id: 'https://example.test/a', url: 'https://example.test/a', retrievedAt: AT },
    })
    expect(first.deduplicated).toBe(false)
    expect(second.deduplicated).toBe(true)
    expect(second.snapshot.snapshotId).toBe(first.snapshot.snapshotId)
    const object = await readFile(path.join(store.objectsDir, hashRefHex(first.snapshot.snapshotId)))
    expect(object.toString('utf8')).toBe('hello')
  })

  it('refuses a snapshot over the configured cap', async () => {
    const store = makeStore({ maxSnapshotBytes: 4 })
    await expect(
      store.capture({ bytes: 'hello', mediaType: 'text/plain', sourceRef: { kind: 'file', id: 'a', retrievedAt: AT } }),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_TOO_LARGE' })
  })

  it('refuses to overwrite an object whose bytes no longer match its address', async () => {
    const store = makeStore()
    const { snapshot } = await store.capture({
      bytes: 'hello',
      mediaType: 'text/plain',
      sourceRef: { kind: 'file', id: 'a.txt', retrievedAt: AT },
    })
    await writeFile(path.join(store.objectsDir, hashRefHex(snapshot.snapshotId)), 'tampered')
    const reopened = makeStore()
    await expect(
      reopened.capture({ bytes: 'hello', mediaType: 'text/plain', sourceRef: { kind: 'file', id: 'a.txt', retrievedAt: AT } }),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_TAMPERED' })
  })
})

describe('evidence and claims', () => {
  it('rejects evidence that binds an unknown snapshot', async () => {
    const store = makeStore()
    await expect(
      store.addEvidence({
        evidenceId: 'ev-x',
        sourceRef: { kind: 'file', id: 'a', retrievedAt: AT },
        snapshotIds: [`sha256:${'0'.repeat(64)}`],
        anchors: [{ snapshotId: `sha256:${'0'.repeat(64)}`, kind: 'record', value: 'field:x' }],
        provenance: { plugin: 't', version: '1', method: 'm', retrievedAt: AT },
      }),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_MISSING' })
  })

  it('rejects evidence without anchors (no locator, no evidence)', async () => {
    const store = makeStore()
    const { snapshot } = await store.capture({
      bytes: TEXT,
      mediaType: 'text/plain',
      sourceRef: { kind: 'file', id: 'a.txt', retrievedAt: AT },
    })
    await expect(
      store.addEvidence({
        evidenceId: 'ev-x',
        sourceRef: { kind: 'file', id: 'a', retrievedAt: AT },
        snapshotIds: [snapshot.snapshotId],
        anchors: [],
        provenance: { plugin: 't', version: '1', method: 'm', retrievedAt: AT },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_EVIDENCE' })
  })

  it('rejects a claim that binds unknown evidence', async () => {
    const store = makeStore()
    await expect(
      store.addClaim({ claimId: 'cl-x', text: 'x', type: 'other', evidenceRefs: ['ev-nope'] }),
    ).rejects.toMatchObject({ code: 'EVIDENCE_UNKNOWN' })
  })

  it('verifies a claim whose quote and numbers are present', async () => {
    const store = makeStore()
    const { claimId } = await seed(store)
    const claim = await store.verifyClaim(claimId)
    expect(claim.verdict).toBe('verified')
    expect(claim.checks.some(check => check.check === 'quote-span' && check.status === 'pass')).toBe(true)
  })

  it('marks a claim contradicted when its snapshot is tampered after capture', async () => {
    const store = makeStore()
    const { claimId, snapshotId } = await seed(store)
    await writeFile(path.join(store.objectsDir, hashRefHex(snapshotId as HashRef)), 'tampered bytes')
    const claim = await store.verifyClaim(claimId)
    expect(claim.verdict).toBe('contradicted')
    expect(claim.checks.find(check => check.check === 'source-status')?.code).toBe('integrity_mismatch')
  })

  it('refuses to record a verdict without checks', async () => {
    const store = makeStore()
    const { claimId } = await seed(store)
    await expect(store.setVerdict(claimId, 'verified', [])).rejects.toMatchObject({ code: 'INVALID_CLAIM' })
  })

  it('refuses to record not_found as anything but skipped', async () => {
    const store = makeStore()
    const { claimId } = await seed(store)
    const bad = [{ checkId: 'c', check: 'doi-exists', status: 'pass', code: 'not_found', detail: 'x' }] as CheckResult[]
    await expect(store.setVerdict(claimId, 'verified', bad)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('refuses a verified verdict built only from non-verifying checks', async () => {
    const store = makeStore()
    const { claimId } = await seed(store)
    const weak = [{ checkId: 'c', check: 'evidence-present', status: 'pass', detail: 'bound' }] as CheckResult[]
    await expect(store.setVerdict(claimId, 'verified', weak)).rejects.toMatchObject({ code: 'INVALID_CLAIM' })
  })

  it('persists across store instances', async () => {
    const store = makeStore()
    const { claimId } = await seed(store)
    await store.verifyClaim(claimId)
    const reopened = makeStore()
    const claim = await reopened.getClaim(claimId)
    expect(claim?.verdict).toBe('verified')
    expect(await reopened.listEvidence()).toHaveLength(1)
    expect(await reopened.listSnapshots()).toHaveLength(1)
  })

  it('fails loud on a corrupt journal line', async () => {
    const store = makeStore()
    await seed(store)
    await writeFile(path.join(root, 'claims.jsonl'), '{not json}\n', 'utf8')
    const reopened = makeStore()
    await expect(reopened.listClaims()).rejects.toBeInstanceOf(RepStoreError)
  })
})

describe('sealing', () => {
  it('writes a valid, sealed, independently verifiable record', async () => {
    const store = makeStore()
    const { claimId } = await seed(store)
    await store.verifyClaim(claimId)
    const result = await store.seal({ title: 'Test report', topic: 'test-report', generator: GENERATOR })
    expect(result.recordPath.endsWith(`${result.record.recordId}.rep.json`)).toBe(true)
    expect(validateRep(result.record).ok).toBe(true)
    expect(result.manifest.integrity?.manifestHash).toBeDefined()

    const verification = await verifyRecord(result.record, { objectsDir: store.objectsDir })
    expect(verification.ok, JSON.stringify(verification.issues)).toBe(true)
    expect(verification.manifestSeal?.ok).toBe(true)
    expect(verification.snapshots.every(item => item.status === 'ok')).toBe(true)
    expect(verification.anchors.every(anchor => anchor.found)).toBe(true)

    const onDisk = JSON.parse(await readFile(result.recordPath, 'utf8')) as unknown
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(result.record)) as unknown)
  })

  it('refuses to overwrite an existing sealed record', async () => {
    const store = makeStore()
    await seed(store)
    const first = await store.seal({ title: 'T', topic: 't', generator: GENERATOR, recordId: 'rec-fixed' })
    expect(first.record.recordId).toBe('rec-fixed')
    await expect(
      store.seal({ title: 'T', topic: 't', generator: GENERATOR, recordId: 'rec-fixed' }),
    ).rejects.toMatchObject({ code: 'RECORD_EXISTS' })
  })

  it('fails verification when a snapshot is tampered after sealing', async () => {
    const store = makeStore()
    const { claimId, snapshotId } = await seed(store)
    await store.verifyClaim(claimId)
    const sealed = await store.seal({ title: 'T', topic: 't', generator: GENERATOR })
    await writeFile(path.join(store.objectsDir, hashRefHex(snapshotId as HashRef)), 'changed')
    const verification = await verifyRecord(sealed.record, { objectsDir: store.objectsDir })
    expect(verification.ok).toBe(false)
    expect(verification.issues.map(issue => issue.code)).toContain('verify.snapshot_hash_mismatch')
    expect(verification.manifestSeal?.ok).toBe(true) // the seal is intact; the bytes are not
  })

  it('produces a sealed record accepted by the published JSON Schema', async () => {
    const store = makeStore()
    const { claimId } = await seed(store)
    await store.verifyClaim(claimId)
    const sealed = await store.seal({ title: 'Schema report', topic: 'schema', generator: GENERATOR })
    const ajv = new Ajv2020({ strict: false, allErrors: true })
    const validate = ajv.compile(getRepSchema())
    expect(validate(sealed.record), ajv.errorsText(validate.errors)).toBe(true)
  })

  it('counts state for status()', async () => {
    const store = makeStore()
    const { claimId } = await seed(store)
    await store.verifyClaim(claimId)
    const summary = await store.status()
    expect(summary.evidenceCount).toBe(1)
    expect(summary.claimCount).toBe(1)
    expect(summary.verdictCounts.verified).toBe(1)
  })
})
