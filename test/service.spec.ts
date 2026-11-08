/**
 * The Cordis seam: mounting, disposal, and the optional bridge to the legacy
 * `ctx.researchReport` ledger (via a structural fake — core must never import
 * that package).
 * @module test/service.spec
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'
import type { ReportEvidenceRecord, ReportServiceLike } from '../src/service.ts'

const AT = '2026-01-15T10:00:00.000Z'
const TEXT = 'In this fixture the treatment group improved (t(28) = 2.50, p = .018).'
const QUOTE = 'the treatment group improved (t(28) = 2.50, p = .018)'

let root: string
const fibers: Array<{ dispose(): Promise<void> }> = []

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'rep-service-'))
})

afterEach(async () => {
  await Promise.all(fibers.splice(0).map(fiber => fiber.dispose()))
  if (root.startsWith(tmpdir())) await rm(root, { recursive: true, force: true })
})

/** Mount the plugin on a fresh real Cordis context. */
async function mount(config: Record<string, unknown> = {}): Promise<Context> {
  const ctx = new Context()
  const fiber = await ctx.plugin(plugin, { root, ...config })
  fibers.push(fiber as unknown as { dispose(): Promise<void> })
  return ctx
}

/** Register one evidence + claim through the service. */
async function seed(ctx: Context): Promise<{ evidenceId: string; claimId: string }> {
  const service = ctx.researchEvidence
  const { snapshot } = await service.capture({
    bytes: TEXT,
    mediaType: 'text/plain',
    sourceRef: { kind: 'file', id: 'fixtures/service.txt', retrievedAt: AT },
  })
  const { evidence } = await service.addEvidence({
    evidenceId: 'ev-service',
    sourceRef: { kind: 'file', id: 'fixtures/service.txt', retrievedAt: AT },
    snapshotIds: [snapshot.snapshotId],
    anchors: [{ snapshotId: snapshot.snapshotId, kind: 'char', value: 'c.10-77', charRange: { start: 10, end: 77 }, quote: QUOTE }],
    provenance: { plugin: 'test', version: '1', method: 'unit test', retrievedAt: AT },
  })
  const { claim } = await service.addClaim({
    claimId: 'cl-service',
    text: 'The trial reports t(28) = 2.50 with p = .018.',
    type: 'result',
    evidenceRefs: [evidence.evidenceId],
    locator: { snapshotId: snapshot.snapshotId, kind: 'char', value: 'c.10-77', charRange: { start: 10, end: 77 }, quote: QUOTE },
  })
  return { evidenceId: evidence.evidenceId, claimId: claim.claimId }
}

describe('mount', () => {
  it('registers ctx.researchEvidence and unregisters it on dispose', async () => {
    const ctx = await mount()
    expect(ctx.researchEvidence).toBeDefined()
    const { claimId } = await seed(ctx)
    expect((await ctx.researchEvidence.verifyClaim(claimId)).verdict).toBe('verified')
    await fibers.splice(0).map(fiber => fiber.dispose())
    expect(ctx.get('researchEvidence')).toBeUndefined()
  })

  it('mounts nothing when enabled is false', async () => {
    const ctx = await mount({ enabled: false })
    expect(ctx.get('researchEvidence')).toBeUndefined()
  })

  it('fails loud on an invalid bound', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(plugin, { root, maxSnapshotBytes: 0 })).rejects.toThrow(/maxSnapshotBytes/)
  })

  it('seals a record that verifies through the service', async () => {
    const ctx = await mount()
    const { claimId } = await seed(ctx)
    await ctx.researchEvidence.verifyClaim(claimId)
    const sealed = await ctx.researchEvidence.seal({ title: 'Service report', topic: 'service', generator: { name: 't', version: '1' } })
    const verification = await ctx.researchEvidence.verifyRecord(sealed.record)
    expect(verification.ok, JSON.stringify(verification.issues)).toBe(true)
  })
})

describe('research-report bridge', () => {
  /** A structural fake of `ctx.researchReport` covering the bridge surface. */
  function fakeReport(): ReportServiceLike & { registered: string[] } {
    const records = new Map<string, ReportEvidenceRecord>()
    const registered: string[] = []
    return {
      registered,
      async addEvidence(input) {
        const id = input.id ?? `ev-${records.size + 1}`
        const record: ReportEvidenceRecord = {
          id,
          hash: 'a'.repeat(64),
          title: input.title,
          origin: input.origin,
          capturedAt: input.capturedAt ?? AT,
          bytes: Buffer.byteLength(input.content, 'utf8'),
        }
        records.set(id, record)
        registered.push(id)
        return { record, deduplicated: false }
      },
      async getEvidence(id) {
        return records.get(id)
      },
      async readEvidenceContent(id) {
        if (!records.has(id)) return undefined
        return { content: TEXT, integrity: 'ok' }
      },
      async listEvidence() {
        return [...records.values()]
      },
    }
  }

  it('imports legacy evidence with an integrity check', async () => {
    const ctx = new Context()
    const report = fakeReport()
    ctx.provide('researchReport', report as never)
    const fiber = await ctx.plugin(plugin, { root })
    fibers.push(fiber as unknown as { dispose(): Promise<void> })
    await report.addEvidence({ id: 'ev-legacy', title: 'Legacy', origin: 'https://example.test/x', content: TEXT })
    const imported = await ctx.researchEvidence.importReportEvidence('ev-legacy')
    expect(imported.evidenceId).toMatch(/^ev-/u)
    expect(imported.checks?.[0]?.status).toBe('pass')
    const view = await ctx.researchEvidence.getEvidence(imported.evidenceId)
    expect(view?.snapshotIds).toHaveLength(1)
  })

  it('marks an import from a tampered legacy snapshot as failed, never repaired', async () => {
    const ctx = new Context()
    const report = fakeReport()
    ctx.provide('researchReport', report as unknown as never)
    const fiber = await ctx.plugin(plugin, { root })
    fibers.push(fiber as unknown as { dispose(): Promise<void> })
    await report.addEvidence({ id: 'ev-legacy-bad', title: 'Legacy', origin: 'x', content: TEXT })
    report.readEvidenceContent = async () => ({ content: TEXT, integrity: 'tampered' })
    const imported = await ctx.researchEvidence.importReportEvidence('ev-legacy-bad')
    expect(imported.checks?.[0]?.status).toBe('fail')
    expect(imported.checks?.[0]?.code).toBe('integrity_mismatch')
  })

  it('mirrors REP evidence into the legacy ledger', async () => {
    const ctx = new Context()
    const report = fakeReport()
    ctx.provide('researchReport', report as unknown as never)
    const fiber = await ctx.plugin(plugin, { root })
    fibers.push(fiber as unknown as { dispose(): Promise<void> })
    const { evidenceId } = await seed(ctx)
    const mirrored = await ctx.researchEvidence.mirrorToReport(evidenceId)
    expect(mirrored.id).toBe(evidenceId)
    expect(report.registered).toContain(evidenceId)
  })

  it('fails loud when no report service is attached', async () => {
    const ctx = await mount()
    await expect(ctx.researchEvidence.importReportEvidence('ev-x')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(ctx.researchEvidence.mirrorToReport('ev-x')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
