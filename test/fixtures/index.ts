/**
 * Golden fixture catalogue for REP v1.
 *
 * Fixtures are PRODUCED by the real core functions (hashing, canonical JSON,
 * claim evaluation, manifest sealing, audit chaining) and committed as JSON.
 * `test/fixtures.spec.ts` fails when a committed file drifts from this
 * catalogue, so the JSON on disk is always reproducible:
 *
 *   UPDATE_FIXTURES=1 pnpm test
 *
 * Every invalid fixture isolates one invariant so a regression names itself.
 *
 * @module test/fixtures
 */

import { createAuditEvent } from '../../src/audit.ts'
import { evaluateClaim, type ClaimEvidenceText } from '../../src/claim.ts'
import { objectPathOf, sha256Hex, snapshotIdOf } from '../../src/hash.ts'
import { buildManifest, sealManifest } from '../../src/manifest.ts'
import type {
  Anchor,
  AuditEvent,
  CheckResult,
  Claim,
  Evidence,
  Generator,
  ManifestSummary,
  ResearchRecord,
  Snapshot,
  SourceRef,
} from '../../src/types.ts'
import { VERSION } from '../../src/version.ts'

/** Fixed clock so every generated hash is stable across machines. */
export const FIXTURE_AT = '2026-01-15T10:00:00.000Z'

/** Tool identity recorded in fixtures. */
const GENERATOR: Generator = { name: 'dsh-research-core fixture builder', version: VERSION }

/** Article text used by the fixtures (fictional, no real claims). */
export const ARTICLE_TEXT = [
  'Title: Statistical reporting in randomized trials (synthetic fixture)',
  'Journal: Fixture Methods (2024)',
  '',
  'Abstract',
  'We evaluated whether the treatment group improved. In this synthetic fixture the treatment group improved (t(28) = 2.50, p = .018), with a standardized effect of d = 0.45 and a 95% CI of [0.05, 0.85].',
  '',
  'Methods',
  'Participants (n = 30) were randomized to treatment or control.',
  '',
  'Results',
  'The effect size was moderate.',
  '',
].join('\n')

/** The exact quote every quote anchor locates. */
export const ARTICLE_QUOTE = 'the treatment group improved (t(28) = 2.50, p = .018)'

/** A snippet that is deliberately absent from {@link ARTICLE_TEXT}. */
export const ABSENT_QUOTE = 'the effect is definitive'

/** Source reference shared by the article snapshot. */
const ARTICLE_SOURCE: SourceRef = {
  kind: 'file',
  id: 'fixtures/article.txt',
  retrievedAt: FIXTURE_AT,
  metadata: { title: 'Statistical reporting in randomized trials (synthetic fixture)', year: 2024, language: 'en' },
}

/** Build a content-addressed snapshot from text. */
function snapshotOf(text: string, mediaType: Snapshot['mediaType'], sourceRef: SourceRef = ARTICLE_SOURCE): Snapshot {
  const bytes = Buffer.from(text, 'utf8')
  const snapshotId = snapshotIdOf(bytes)
  return {
    snapshotId,
    mediaType,
    bytes: bytes.byteLength,
    path: objectPathOf(snapshotId),
    capturedAt: FIXTURE_AT,
    sourceRef,
    encoding: 'utf-8',
  }
}

/** Build proof-of-capture check results for an evidence item. */
function evidenceChecks(check: CheckResult): CheckResult[] {
  return [check]
}

/** Build the article snapshot and evidence item. */
function articleEvidence(): { snapshot: Snapshot; evidence: Evidence; text: string } {
  const snapshot = snapshotOf(ARTICLE_TEXT, 'text/plain')
  const anchor: Anchor = {
    anchorId: 'anc-article-quote',
    snapshotId: snapshot.snapshotId,
    kind: 'char',
    value: 'c.152-219',
    charRange: { start: 152, end: 219 },
    quote: ARTICLE_QUOTE,
    quoteHash: sha256Hex(ARTICLE_QUOTE),
  }
  const evidence: Evidence = {
    evidenceId: 'ev-fixture-article',
    title: 'Synthetic fixture article',
    sourceRef: ARTICLE_SOURCE,
    snapshotIds: [snapshot.snapshotId],
    anchors: [anchor],
    provenance: {
      plugin: 'dsh-research-core',
      version: VERSION,
      method: 'fixture build (text/plain snapshot of a synthetic article)',
      retrievedAt: FIXTURE_AT,
    },
    checks: evidenceChecks({
      checkId: 'chk-fixture-source-status',
      check: 'source-status',
      status: 'pass',
      detail: 'fixture snapshot bytes re-hash to the recorded address',
    }),
  }
  return { snapshot, evidence, text: ARTICLE_TEXT }
}

/** The evidence view used by claim evaluation. */
function viewOf(evidence: Evidence, text: string): ClaimEvidenceText {
  return { evidenceId: evidence.evidenceId, texts: [text], integrity: 'ok', binaryOnly: false }
}

/** Evaluate a claim and return it with its derived verdict. */
function evaluatedClaim(registration: Claim, evidence: Evidence, text: string): Claim {
  const evaluation = evaluateClaim(registration, [viewOf(evidence, text)], evidence.anchors)
  return { ...registration, checks: evaluation.checks, verdict: evaluation.verdict, verdictAt: FIXTURE_AT }
}

/** Build the three article claims (verified / insufficient / disproven). */
function articleClaims(evidence: Evidence, text: string): Claim[] {
  const verified = evaluatedClaim(
    {
      claimId: 'cl-fixture-verified',
      text: 'The trial reports t(28) = 2.50 with p = .018.',
      type: 'result',
      evidenceRefs: [evidence.evidenceId],
      checks: [],
      locator: {
        snapshotId: evidence.snapshotIds[0]!,
        kind: 'char',
        value: 'c.152-219',
        charRange: { start: 152, end: 219 },
        quote: ARTICLE_QUOTE,
      },
    },
    evidence,
    text,
  )
  const insufficient = evaluatedClaim(
    {
      claimId: 'cl-fixture-insufficient',
      text: 'The standardized effect was d = 0.80.',
      type: 'number',
      evidenceRefs: [evidence.evidenceId],
      checks: [],
      locator: {
        snapshotId: evidence.snapshotIds[0]!,
        kind: 'char',
        value: 'c.220-271',
        charRange: { start: 220, end: 271 },
        quote: 'with a standardized effect of d = 0.45',
      },
    },
    evidence,
    text,
  )
  const disproven = evaluatedClaim(
    {
      claimId: 'cl-fixture-disproven',
      text: 'The authors conclude that the effect is definitive.',
      type: 'quote',
      evidenceRefs: [evidence.evidenceId],
      checks: [],
      locator: {
        snapshotId: evidence.snapshotIds[0]!,
        kind: 'char',
        value: 'c.300-326',
        charRange: { start: 300, end: 326 },
        quote: ABSENT_QUOTE,
      },
    },
    evidence,
    text,
  )
  return [verified, insufficient, disproven]
}

/** Build a deterministic audit chain. */
function auditChain(entries: ReadonlyArray<readonly [string, Record<string, unknown>]>): AuditEvent[] {
  const events: AuditEvent[] = []
  let prevHash: string | undefined
  for (const [index, [type, payload]] of entries.entries()) {
    const event = createAuditEvent({
      eventId: `evt-${String(index + 1).padStart(6, '0')}`,
      at: FIXTURE_AT,
      actor: 'plugin',
      type,
      payload,
      ...(prevHash === undefined ? {} : { prevHash }),
    })
    events.push(event)
    prevHash = event.hash
  }
  return events
}

/** Build an unsealed record from parts. */
function recordOf(parts: {
  recordId: string
  snapshots: Snapshot[]
  evidence: Evidence[]
  claims: Claim[]
  audit?: AuditEvent[]
  artifacts?: ResearchRecord['artifacts']
}): Omit<ResearchRecord, 'manifest'> {
  return {
    schemaVersion: 1,
    recordId: parts.recordId,
    createdAt: FIXTURE_AT,
    generator: GENERATOR,
    snapshots: parts.snapshots,
    evidence: parts.evidence,
    claims: parts.claims,
    ...(parts.audit === undefined ? {} : { audit: parts.audit }),
    ...(parts.artifacts === undefined ? {} : { artifacts: parts.artifacts }),
  }
}

/** Seal a record with its manifest. */
function sealed(base: Omit<ResearchRecord, 'manifest'>, title: string, topic: string): ResearchRecord {
  const recordFile = `${base.recordId}.rep.json`
  const manifest = sealManifest(
    buildManifest(base, { title, topic, generator: GENERATOR, generatedAt: FIXTURE_AT, recordFile }),
    FIXTURE_AT,
  )
  return { ...base, manifest }
}

/** One fixture entry. */
export interface FixtureSpec {
  /** File name under `test/fixtures/`. */
  readonly file: string
  /** The record value. */
  readonly value: unknown
  /** Expected validator outcome. */
  readonly expect: {
    /** Whether `validateRep` must accept it. */
    readonly valid: boolean
    /** Stable issue codes that must all be present (subset check). */
    readonly codes: readonly string[]
    /** JSON Schema expectation: rejects it, accepts it, or unconstrained. */
    readonly schema: 'reject' | 'accept' | 'either'
  }
  /** What this fixture pins down. */
  readonly about: string
}

/** Deep clone helper for building invalid variants. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Access a cloned object as a mutable record. */
function obj(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>
}

/** Access a cloned array of objects. */
function arr(value: unknown): Record<string, unknown>[] {
  return value as Record<string, unknown>[]
}

/** Build every fixture. */
export function buildFixtures(): FixtureSpec[] {
  const { snapshot, evidence, text } = articleEvidence()
  const claims = articleClaims(evidence, text)
  const audit = auditChain([
    ['snapshot.captured', { snapshotId: snapshot.snapshotId, bytes: snapshot.bytes }],
    ['evidence.registered', { evidenceId: evidence.evidenceId }],
    ['claim.registered', { claimId: 'cl-fixture-verified' }],
    ['claim.verdict', { claimId: 'cl-fixture-verified', verdict: 'verified' }],
  ])
  const artifacts = [
    {
      artifactId: 'art-fixture-seed',
      kind: 'seed' as const,
      hash: snapshotIdOf('fixture-seed-42'),
      description: 'Random seed 42 used by the synthetic reproduction',
      createdAt: FIXTURE_AT,
    },
  ]

  const minimal = recordOf({
    recordId: 'rec-fixture-minimal',
    snapshots: [snapshot],
    evidence: [evidence],
    claims: [claims[0]!],
  })
  const sealedRecord = sealed(
    recordOf({
      recordId: 'rec-fixture-sealed',
      snapshots: [snapshot],
      evidence: [evidence],
      claims,
      audit,
      artifacts,
    }),
    'Fixture sealed report',
    'fixture-sealed',
  )

  // ── not-found / unchecked ────────────────────────────────────────────────
  const missingSource: SourceRef = {
    kind: 'doi',
    id: '10.9999/fixture.missing',
    retrievedAt: FIXTURE_AT,
    metadata: { title: 'A citation Crossref does not know' },
  }
  const missingSnapshot = snapshotOf('{"query":"10.9999/fixture.missing","total-results":0}', 'application/json', missingSource)
  const missingEvidence: Evidence = {
    evidenceId: 'ev-fixture-not-found',
    title: 'Crossref lookup that returned no record',
    sourceRef: missingSource,
    snapshotIds: [missingSnapshot.snapshotId],
    anchors: [{ snapshotId: missingSnapshot.snapshotId, kind: 'record', value: 'field:total-results' }],
    provenance: {
      plugin: 'dsh-research-core',
      version: VERSION,
      method: 'fixture build (recorded empty Crossref response)',
      retrievedAt: FIXTURE_AT,
    },
    checks: [
      {
        checkId: 'chk-fixture-doi-exists',
        check: 'doi-exists',
        status: 'skipped',
        code: 'not_found',
        severity: 'info',
        detail: 'Crossref returned no record for 10.9999/fixture.missing; not_found is not evidence of fabrication and not evidence of cleanliness',
      },
    ],
  }
  const notFoundClaim: Claim = {
    claimId: 'cl-fixture-not-found',
    text: 'The cited work exists and reports the stated effect.',
    type: 'metadata',
    evidenceRefs: [missingEvidence.evidenceId],
    checks: [
      {
        checkId: 'chk-fixture-not-found-claim',
        check: 'doi-exists',
        status: 'skipped',
        code: 'not_found',
        detail: 'the DOI could not be located, so the claim cannot be decided',
      },
    ],
    verdict: 'insufficient',
    verdictAt: FIXTURE_AT,
  }
  const notFoundRecord = sealed(
    recordOf({
      recordId: 'rec-fixture-not-found',
      snapshots: [missingSnapshot],
      evidence: [missingEvidence],
      claims: [notFoundClaim],
      audit: auditChain([['evidence.registered', { evidenceId: missingEvidence.evidenceId }]]),
    }),
    'Fixture not-found report',
    'fixture-not-found',
  )

  // ── invalid variants ─────────────────────────────────────────────────────
  const noSnapshot = clone(sealedRecord)
  arr(obj(noSnapshot)['evidence'])[0]!['snapshotIds'] = []

  const unknownSnapshot = clone(sealedRecord)
  arr(obj(unknownSnapshot)['evidence'])[0]!['snapshotIds'] = [`sha256:${'0'.repeat(64)}`]

  const noAnchor = clone(sealedRecord)
  arr(obj(noAnchor)['evidence'])[0]!['anchors'] = []

  const verifiedNoEvidence = clone(sealedRecord)
  arr(obj(verifiedNoEvidence)['claims'])[0]!['evidenceRefs'] = []

  const verifiedNoCheck = clone(sealedRecord)
  arr(obj(verifiedNoCheck)['claims'])[0]!['checks'] = []

  const verifiedWithFail = clone(sealedRecord)
  arr(arr(obj(verifiedWithFail)['claims'])[0]!['checks']).push({
    checkId: 'chk-fixture-injected-fail',
    check: 'quote-span',
    status: 'fail',
    detail: 'injected failure used to pin the verified-claim invariant',
  })

  const verdictNoChecks = clone(sealedRecord)
  arr(obj(verdictNoChecks)['claims'])[0]!['checks'] = []

  const notFoundAsPass = clone(notFoundRecord)
  const notFoundChecks = arr(arr(obj(notFoundAsPass)['evidence'])[0]!['checks'])
  notFoundChecks[0]!['status'] = 'pass'

  const pathMismatch = clone(sealedRecord)
  arr(obj(pathMismatch)['snapshots'])[0]!['path'] = `objects/${'a'.repeat(64)}`

  const tampered = clone(sealedRecord)
  arr(obj(tampered)['snapshots'])[0]!['integrity'] = { status: 'tampered', checkedAt: FIXTURE_AT }

  const quoteHashMismatch = clone(sealedRecord)
  arr(arr(obj(quoteHashMismatch)['evidence'])[0]!['anchors'])[0]!['quoteHash'] = 'b'.repeat(64)

  const brokenChain = clone(sealedRecord)
  arr(obj(brokenChain)['audit'])[1]!['payload'] = { evidenceId: 'ev-tampered-after-the-fact' }

  const brokenSeal = clone(sealedRecord)
  obj(obj(brokenSeal)['manifest'])['title'] = 'A title changed after sealing'

  const brokenSummary = clone(sealedRecord)
  const summary = obj(sealedRecord.manifest?.summary) as unknown as ManifestSummary
  obj(obj(brokenSummary)['manifest'])['summary'] = { ...summary, claimCount: summary.claimCount + 1 }

  const wrongVersion = clone(sealedRecord)
  obj(wrongVersion)['schemaVersion'] = 2

  const duplicateIds = clone(sealedRecord)
  const duplicatedEvidence = clone(arr(obj(duplicateIds)['evidence'])[0]!)
  arr(obj(duplicateIds)['evidence']).push(duplicatedEvidence)

  const claimUnknownEvidence = clone(sealedRecord)
  arr(obj(claimUnknownEvidence)['claims'])[0]!['evidenceRefs'] = ['ev-does-not-exist']

  return [
    {
      file: 'valid-minimal.rep.json',
      value: minimal,
      expect: { valid: true, codes: [], schema: 'accept' },
      about: 'minimal record: one snapshot, one evidence, one verified claim',
    },
    {
      file: 'valid-sealed.rep.json',
      value: sealedRecord,
      expect: { valid: true, codes: [], schema: 'accept' },
      about: 'sealed manifest + audit chain + artifacts + verified/insufficient/disproven claims',
    },
    {
      file: 'valid-not-found-unchecked.rep.json',
      value: notFoundRecord,
      expect: { valid: true, codes: [], schema: 'accept' },
      about: 'not_found is skipped, evidence stays unchecked, claim is insufficient',
    },
    {
      file: 'invalid-evidence-no-snapshot.rep.json',
      value: noSnapshot,
      expect: { valid: false, codes: ['evidence.no_snapshot'], schema: 'reject' },
      about: 'evidence without a snapshot is invalid by design',
    },
    {
      file: 'invalid-evidence-unknown-snapshot.rep.json',
      value: unknownSnapshot,
      expect: { valid: false, codes: ['evidence.snapshot_unknown'], schema: 'either' },
      about: 'evidence cannot bind a snapshot the record does not contain',
    },
    {
      file: 'invalid-evidence-no-anchor.rep.json',
      value: noAnchor,
      expect: { valid: false, codes: ['evidence.no_anchor'], schema: 'reject' },
      about: 'evidence needs at least one locator anchor',
    },
    {
      file: 'invalid-claim-verified-no-evidence.rep.json',
      value: verifiedNoEvidence,
      expect: { valid: false, codes: ['claim.verdict_invariant'], schema: 'reject' },
      about: 'a verified claim must bind evidence',
    },
    {
      file: 'invalid-claim-verified-no-check.rep.json',
      value: verifiedNoCheck,
      expect: { valid: false, codes: ['claim.verdict_invariant'], schema: 'reject' },
      about: 'a verdict needs at least one check',
    },
    {
      file: 'invalid-claim-verified-with-fail.rep.json',
      value: verifiedWithFail,
      expect: { valid: false, codes: ['claim.verdict_invariant'], schema: 'reject' },
      about: 'a verified claim must not carry a failing check',
    },
    {
      file: 'invalid-claim-verdict-no-checks.rep.json',
      value: verdictNoChecks,
      expect: { valid: false, codes: ['claim.verdict_invariant'], schema: 'reject' },
      about: 'a verdict without checks is illegal',
    },
    {
      file: 'invalid-not-found-as-pass.rep.json',
      value: notFoundAsPass,
      expect: { valid: false, codes: ['check.not_found_status'], schema: 'reject' },
      about: 'not_found can never be recorded as pass',
    },
    {
      file: 'invalid-snapshot-path-mismatch.rep.json',
      value: pathMismatch,
      expect: { valid: false, codes: ['snapshot.path_mismatch'], schema: 'either' },
      about: 'snapshot.path must be the content address',
    },
    {
      file: 'invalid-snapshot-tampered.rep.json',
      value: tampered,
      expect: { valid: false, codes: ['snapshot.integrity'], schema: 'either' },
      about: 'a record carrying tampered bytes does not validate as intact',
    },
    {
      file: 'invalid-anchor-quote-hash.rep.json',
      value: quoteHashMismatch,
      expect: { valid: false, codes: ['anchor.quote_hash_mismatch'], schema: 'either' },
      about: 'anchor.quoteHash must equal sha256(quote)',
    },
    {
      file: 'invalid-audit-chain.rep.json',
      value: brokenChain,
      expect: { valid: false, codes: ['audit.hash_mismatch'], schema: 'either' },
      about: 'editing an audit payload breaks the chain',
    },
    {
      file: 'invalid-manifest-seal.rep.json',
      value: brokenSeal,
      expect: { valid: false, codes: ['manifest.seal_mismatch'], schema: 'either' },
      about: 'the manifest seal detects post-hoc edits',
    },
    {
      file: 'invalid-manifest-summary.rep.json',
      value: brokenSummary,
      expect: { valid: false, codes: ['manifest.summary_mismatch'], schema: 'either' },
      about: 'manifest counters must match the record',
    },
    {
      file: 'invalid-schema-version.rep.json',
      value: wrongVersion,
      expect: { valid: false, codes: ['record.schema_version'], schema: 'reject' },
      about: 'schemaVersion must be exactly 1',
    },
    {
      file: 'invalid-duplicate-ids.rep.json',
      value: duplicateIds,
      expect: { valid: false, codes: ['id.duplicate'], schema: 'either' },
      about: 'ids are unique inside one record',
    },
    {
      file: 'invalid-claim-evidence-unknown.rep.json',
      value: claimUnknownEvidence,
      expect: { valid: false, codes: ['claim.evidence_unknown'], schema: 'either' },
      about: 'claims cannot reference evidence outside the record',
    },
  ]
}
