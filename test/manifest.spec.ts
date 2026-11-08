/**
 * Manifest sealing and the derived evidence status — including the rule that a
 * `not_found` outcome can never surface as `ok`.
 * @module test/manifest.spec
 */

import { describe, expect, it } from 'vitest'
import { sha256Hex, snapshotIdOf } from '../src/hash.ts'
import { buildManifest, evidenceStatusOf, manifestHashOf, sealManifest, summarizeRecord, verifyManifestSeal } from '../src/manifest.ts'
import type { CheckResult, Claim, Evidence, ResearchRecord, Snapshot } from '../src/types.ts'

const AT = '2026-01-15T10:00:00.000Z'
const GENERATOR = { name: 'test', version: '1.0.0' }

const snapshot: Snapshot = (() => {
  const id = snapshotIdOf('body')
  return {
    snapshotId: id,
    mediaType: 'text/plain',
    bytes: 4,
    path: `objects/${sha256Hex('body')}`,
    capturedAt: AT,
    sourceRef: { kind: 'file', id: 'a.txt', retrievedAt: AT },
  }
})()

/** An evidence item with the given checks. */
function evidenceOf(checks?: readonly CheckResult[]): Evidence {
  return {
    evidenceId: 'ev-1',
    sourceRef: { kind: 'doi', id: '10.1000/x', retrievedAt: AT },
    snapshotIds: [snapshot.snapshotId],
    anchors: [{ snapshotId: snapshot.snapshotId, kind: 'record', value: 'field:title' }],
    provenance: { plugin: 'p', version: '1', method: 'm', retrievedAt: AT },
    ...(checks === undefined ? {} : { checks }),
  }
}

/** A claim with the given verdict/checks. */
function claimOf(id: string, verdict: Claim['verdict'], checks: readonly CheckResult[]): Claim {
  return { claimId: id, text: `text ${id}`, type: 'result', evidenceRefs: ['ev-1'], checks, ...(verdict === undefined ? {} : { verdict }) }
}

/** A record view without a manifest. */
function recordOf(evidence: Evidence[], claims: Claim[]): Omit<ResearchRecord, 'manifest'> {
  return {
    schemaVersion: 1,
    recordId: 'rec-1',
    createdAt: AT,
    generator: GENERATOR,
    snapshots: [snapshot],
    evidence,
    claims,
  }
}

describe('evidenceStatusOf', () => {
  it('is unchecked without checks', () => {
    expect(evidenceStatusOf(evidenceOf())).toBe('unchecked')
  })

  it('treats not_found as unchecked, never as ok', () => {
    expect(
      evidenceStatusOf(
        evidenceOf([{ checkId: 'c', check: 'doi-exists', status: 'skipped', code: 'not_found', detail: 'no record' }]),
      ),
    ).toBe('unchecked')
  })

  it('is ok for a passing check, warn for a warning, fail for a failure', () => {
    expect(evidenceStatusOf(evidenceOf([{ checkId: 'c', check: 'doi-exists', status: 'pass', detail: 'found' }]))).toBe('ok')
    expect(evidenceStatusOf(evidenceOf([{ checkId: 'c', check: 'metadata-match', status: 'warn', detail: 'year off' }]))).toBe('warn')
    expect(evidenceStatusOf(evidenceOf([{ checkId: 'c', check: 'metadata-match', status: 'fail', detail: 'title differs' }]))).toBe('fail')
  })
})

describe('summarizeRecord', () => {
  it('counts verdicts, failed checks and not-found checks', () => {
    const evidence = evidenceOf([
      { checkId: 'c1', check: 'doi-exists', status: 'fail', detail: 'x' },
      { checkId: 'c2', check: 'retraction', status: 'skipped', code: 'not_found', detail: 'x' },
    ])
    const claims = [
      claimOf('cl-1', 'verified', [{ checkId: 'c3', check: 'quote-span', status: 'pass', detail: 'x' }]),
      claimOf('cl-2', 'insufficient', [{ checkId: 'c4', check: 'number-match', status: 'fail', detail: 'x' }]),
    ]
    const summary = summarizeRecord(recordOf([evidence], claims))
    expect(summary.evidenceCount).toBe(1)
    expect(summary.claimCount).toBe(2)
    expect(summary.snapshotCount).toBe(1)
    expect(summary.verdictCounts).toEqual({ verified: 1, unverified: 0, insufficient: 1, contradicted: 0, disproven: 0 })
    expect(summary.failedChecks).toBe(2)
    expect(summary.notFoundChecks).toBe(1)
  })
})

describe('sealing', () => {
  const base = recordOf(
    [evidenceOf()],
    [claimOf('cl-1', 'verified', [{ checkId: 'c', check: 'quote-span', status: 'pass', detail: 'x' }])],
  )
  const manifest = buildManifest(base, { title: 'T', topic: 't', generator: GENERATOR, generatedAt: AT })

  it('records a manifest without integrity', () => {
    expect(manifest.integrity).toBeUndefined()
    expect(manifest.claims[0]?.textHash).toBe(sha256Hex('text cl-1'))
  })

  it('seals and re-verifies', () => {
    const sealed = sealManifest(manifest, AT)
    expect(sealed.integrity?.algorithm).toBe('sha256')
    expect(verifyManifestSeal(sealed)).toEqual({ ok: true, expected: manifestHashOf(sealed), recorded: sealed.integrity?.manifestHash })
  })

  it('detects edits after sealing', () => {
    const sealed = sealManifest(manifest, AT)
    const edited = { ...sealed, title: 'Changed' }
    const result = verifyManifestSeal(edited)
    expect(result.ok).toBe(false)
  })

  it('reports a missing seal instead of assuming success', () => {
    expect(verifyManifestSeal(manifest).ok).toBe(false)
  })
})
