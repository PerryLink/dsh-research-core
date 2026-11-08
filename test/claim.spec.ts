/**
 * Byte-level claim evaluation. Each test pins one documented verdict mapping —
 * the contract a reviewer relies on when deciding whether to trust a verdict.
 * @module test/claim.spec
 */

import { describe, expect, it } from 'vitest'
import {
  claimInvariantViolations,
  evaluateClaim,
  extractNumericTokens,
  normalizeText,
  numericTokensEqual,
  type ClaimEvidenceText,
} from '../src/claim.ts'
import type { Anchor, CheckResult, Claim, HashRef, SnapshotIntegrityStatus } from '../src/types.ts'

const SNAPSHOT: HashRef = `sha256:${'a'.repeat(64)}`

/** A claim with the given text/type and an optional locator quote. */
function claimOf(text: string, options: { type?: Claim['type']; quote?: string; evidenceRefs?: string[] } = {}): Claim {
  const locator: Anchor | undefined =
    options.quote === undefined
      ? undefined
      : { snapshotId: SNAPSHOT, kind: 'char', value: 'c.10-40', charRange: { start: 10, end: 40 }, quote: options.quote }
  return {
    claimId: 'cl-test',
    text,
    type: options.type ?? 'result',
    evidenceRefs: options.evidenceRefs ?? ['ev-test'],
    checks: [],
    ...(locator === undefined ? {} : { locator }),
  }
}

/** One bound evidence view. */
function view(texts: string[], integrity: SnapshotIntegrityStatus | 'unknown' = 'ok'): ClaimEvidenceText {
  return { evidenceId: 'ev-test', texts, integrity, binaryOnly: texts.length === 0 }
}

/** Find a check by kind. */
function check(checks: readonly CheckResult[], kind: CheckResult['check']): CheckResult {
  const found = checks.find(item => item.check === kind)
  if (found === undefined) throw new Error(`no ${kind} check in ${checks.map(item => item.check).join(',')}`)
  return found
}

describe('normalizeText', () => {
  it('normalizes unicode and whitespace but keeps punctuation', () => {
    expect(normalizeText('a\u00a0 b\n\tc')).toBe('a b c')
    expect(normalizeText('ﬁnal')).toBe('final')
    expect(normalizeText('ｐ = .018')).toBe('p = .018')
    expect(normalizeText('soft\u00adhyphen')).toBe('softhyphen')
    expect(normalizeText('p = .018.')).toBe('p = .018.')
  })
})

describe('numeric literal extraction', () => {
  it('reads integers, decimals, thousands separators, signs, exponents and units', () => {
    const values = extractNumericTokens('n = 1,234; d = -0.5; p = .018; growth 12%; tiny 2.5e-3; negative -3')
    expect(values.map(token => token.value)).toEqual([1234, -0.5, 0.018, 12, 0.0025, -3])
    expect(values.find(token => token.value === 12)?.unit).toBe('%')
  })

  it('skips bare years but keeps them when they carry a unit', () => {
    expect(extractNumericTokens('published in 2021 and 1999')).toHaveLength(0)
    expect(extractNumericTokens('2021%')).toHaveLength(1)
  })

  it('compares values with formatting tolerance and unit sensitivity', () => {
    const [a] = extractNumericTokens('2.50')
    const [b] = extractNumericTokens('2.5')
    const [c] = extractNumericTokens('12%')
    const [d] = extractNumericTokens('12')
    expect(numericTokensEqual(a!, b!)).toBe(true)
    expect(numericTokensEqual(c!, d!)).toBe(false)
    expect(numericTokensEqual(extractNumericTokens('1,234')[0]!, extractNumericTokens('1234')[0]!)).toBe(true)
  })
})

describe('evaluateClaim', () => {
  it('marks a claim with no evidence unverified (never false)', () => {
    const result = evaluateClaim(claimOf('Anything at all.', { evidenceRefs: [] }), [])
    expect(result.verdict).toBe('unverified')
    expect(check(result.checks, 'evidence-present').status).toBe('skipped')
    expect(check(result.checks, 'evidence-present').code).toBe('insufficient_evidence')
  })

  it('verifies a claim whose quote and numbers are present', () => {
    const result = evaluateClaim(
      claimOf('The trial reports t(28) = 2.50 with p = .018.', {
        quote: 'the treatment group improved (t(28) = 2.50, p = .018)',
      }),
      [view(['In this fixture the treatment group improved (t(28) = 2.50, p = .018), with d = 0.45.'])],
    )
    expect(result.verdict).toBe('verified')
    expect(check(result.checks, 'quote-span').status).toBe('pass')
    expect(check(result.checks, 'number-match').status).toBe('pass')
  })

  it('disproves a claim whose quoted span is absent', () => {
    const result = evaluateClaim(claimOf('The authors say the effect is definitive.', { type: 'quote', quote: 'the effect is definitive' }), [
      view(['The effect size was moderate.']),
    ])
    expect(result.verdict).toBe('disproven')
    expect(check(result.checks, 'quote-span').status).toBe('fail')
  })

  it('reports a missing number as insufficient, not as false', () => {
    const result = evaluateClaim(claimOf('The standardized effect was d = 0.80.', { type: 'number', quote: 'standardized effect' }), [
      view(['with a standardized effect of d = 0.45']),
    ])
    expect(result.verdict).toBe('insufficient')
    expect(check(result.checks, 'number-match').status).toBe('fail')
    expect(result.checks.some(item => item.code === 'insufficient_evidence')).toBe(true)
  })

  it('contradicts a claim when the bound snapshot no longer matches its hash', () => {
    const result = evaluateClaim(claimOf('p = .018', { quote: 'p = .018' }), [view(['p = .018'], 'tampered')])
    expect(result.verdict).toBe('contradicted')
    expect(check(result.checks, 'source-status').status).toBe('fail')
    expect(check(result.checks, 'source-status').code).toBe('integrity_mismatch')
  })

  it('is insufficient when only undecodable binary snapshots are bound', () => {
    const result = evaluateClaim(claimOf('p = .018', { quote: 'p = .018' }), [view([])])
    expect(result.verdict).toBe('insufficient')
    expect(check(result.checks, 'quote-span').status).toBe('skipped')
    expect(check(result.checks, 'quote-span').code).toBe('unsupported_media_type')
  })

  it('does not let an unrelated evidence anchor poison a verified claim', () => {
    const unrelated: Anchor = {
      snapshotId: SNAPSHOT,
      kind: 'char',
      value: 'c.1-20',
      charRange: { start: 1, end: 20 },
      quote: 'a sentence that is not in the source',
    }
    const result = evaluateClaim(
      claimOf('The trial reports t(28) = 2.50 with p = .018.', { quote: 'the treatment group improved (t(28) = 2.50, p = .018)' }),
      [view(['In this fixture the treatment group improved (t(28) = 2.50, p = .018).'])],
      [unrelated],
    )
    expect(result.verdict).toBe('verified')
  })

  it('flags a claim typed as a number that contains no number', () => {
    const result = evaluateClaim(claimOf('The effect was large.', { type: 'number', quote: 'The effect' }), [view(['The effect was large.'])])
    expect(result.verdict).toBe('insufficient')
    expect(check(result.checks, 'number-match').status).toBe('fail')
  })
})

describe('claimInvariantViolations', () => {
  const passing: CheckResult = { checkId: 'c1', check: 'quote-span', status: 'pass', detail: 'found' }
  const failing: CheckResult = { checkId: 'c2', check: 'quote-span', status: 'fail', detail: 'missing' }

  it('accepts a well-formed verified claim', () => {
    expect(
      claimInvariantViolations({ claimId: 'c', text: 'x', type: 'quote', evidenceRefs: ['e'], checks: [passing], verdict: 'verified' }),
    ).toEqual([])
  })

  it('rejects verified claims without evidence, without a passing check, or with a failure', () => {
    const base = { claimId: 'c', text: 'x', type: 'quote' as const, checks: [passing], verdict: 'verified' as const }
    expect(claimInvariantViolations({ ...base, evidenceRefs: [] })).toContain('a verified claim must bind at least one evidence item')
    expect(
      claimInvariantViolations({ ...base, evidenceRefs: ['e'], checks: [{ checkId: 'c0', check: 'evidence-present', status: 'pass', detail: 'x' }] }),
    ).toContain('a verified claim needs at least one passing verifying check')
    expect(claimInvariantViolations({ ...base, evidenceRefs: ['e'], checks: [passing, failing] })).toContain(
      'a verified claim must not carry a failing check',
    )
  })

  it('requires an explanation for insufficient and a failure for disproven', () => {
    expect(
      claimInvariantViolations({
        claimId: 'c',
        text: 'x',
        type: 'quote',
        evidenceRefs: ['e'],
        checks: [{ checkId: 'c3', check: 'other', status: 'pass', detail: 'x' }],
        verdict: 'insufficient',
      }),
    ).toContain('an insufficient claim must carry a skipped/warning check explaining why')
    expect(
      claimInvariantViolations({
        claimId: 'c',
        text: 'x',
        type: 'quote',
        evidenceRefs: ['e'],
        checks: [passing],
        verdict: 'disproven',
      }),
    ).toContain('a disproven claim must carry a failing or warning check')
  })
})
