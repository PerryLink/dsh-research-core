/**
 * Defensive validation: untrusted `.rep.json` input must produce issues, never
 * exceptions — and manifest comparison must ignore JSON key order.
 * @module test/validate.spec
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { validateRep } from '../src/validate.ts'
import { verifyRecord } from '../src/verify.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const BASE = {
  schemaVersion: 1,
  recordId: 'rec-defensive',
  createdAt: '2026-01-15T10:00:00.000Z',
  snapshots: [],
  evidence: [],
  claims: [],
}

/** Parse a fixture without typing every field. */
async function fixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(here, 'fixtures', name), 'utf8')) as Record<string, unknown>
}

describe('validateRep on malformed input', () => {
  it('reports a manifest without its required arrays instead of throwing', () => {
    const result = validateRep({ ...BASE, manifest: { schemaVersion: 1 } })
    expect(result.ok).toBe(false)
    expect(result.issues.map(issue => issue.code)).toEqual(
      expect.arrayContaining(['manifest.shape', 'manifest.missing_seal']),
    )
  })

  it('reports malformed manifest entries instead of throwing', () => {
    const result = validateRep({
      ...BASE,
      manifest: {
        schemaVersion: 1,
        manifestId: 'man-x',
        generatedAt: '2026-01-15T10:00:00.000Z',
        title: 't',
        topic: 't',
        generator: { name: 'n', version: '1' },
        evidence: [null],
        claims: [42],
        summary: {},
      },
    })
    expect(result.ok).toBe(false)
    expect(result.issues.some(issue => issue.code === 'manifest.shape')).toBe(true)
  })

  it('reports a non-canonicalizable audit payload as a chain defect', () => {
    const result = validateRep({
      ...BASE,
      audit: [
        {
          eventId: 'evt-1',
          at: '2026-01-15T10:00:00.000Z',
          actor: 'plugin',
          type: 'snapshot.captured',
          // JSON.parse('1e999') is Infinity: valid JSON text, not canonicalizable.
          payload: { bytes: Number.POSITIVE_INFINITY },
          hash: 'a'.repeat(64),
        },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.issues.map(issue => issue.code)).toContain('audit.hash_mismatch')
  })

  it('reports a verdict carrying a malformed check instead of throwing', () => {
    const result = validateRep({
      ...BASE,
      claims: [
        {
          claimId: 'cl-x',
          text: 'x',
          type: 'other',
          evidenceRefs: [],
          checks: [null],
          verdict: 'verified',
        },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.issues.map(issue => issue.code)).toEqual(
      expect.arrayContaining(['check.shape', 'claim.verdict_invariant']),
    )
  })

  it('verifyRecord returns a failure report for a non-object record', async () => {
    const result = await verifyRecord(42)
    expect(result.ok).toBe(false)
    expect(result.snapshots).toEqual([])
    expect(result.issues.map(issue => issue.code)).toContain('record.not_object')
  })
})

describe('manifest summary comparison', () => {
  it('ignores JSON key order', async () => {
    const record = await fixture('valid-sealed.rep.json')
    const manifest = record['manifest'] as Record<string, unknown>
    const summary = manifest['summary'] as Record<string, unknown>
    manifest['summary'] = Object.fromEntries(
      Object.keys(summary)
        .sort()
        .map(key => [key, summary[key]]),
    )
    // The seal is over canonical JSON, so reordering keys cannot change it.
    expect(validateRep(record).ok).toBe(true)
  })
})
