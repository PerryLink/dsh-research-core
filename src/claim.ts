/**
 * Deterministic, byte-level claim evaluation.
 *
 * This is deliberately NOT semantic: a quote must occur verbatim (after
 * Unicode/whitespace normalization) in a bound snapshot, and every numeric
 * literal in the claim must occur as a literal in one of them. Nothing is
 * inferred, so every outcome is reproducible by a human with the same bytes.
 *
 * Verdict mapping (documented contract):
 * - bound evidence missing/tampered            → `contradicted`
 * - evidence bound but nothing checkable       → `insufficient` (code `insufficient_evidence`)
 * - a verbatim quote is absent from the source → `disproven`
 * - a claim number is absent from the source   → `insufficient`
 *   (a number may be computed, not quoted — calling it false would overclaim)
 * - every checkable literal found              → `verified`
 *
 * @module @perrylink/dsh-research-core/claim
 */

import { stableId } from './hash.ts'
import type { Anchor, CheckCode, CheckResult, Claim, SnapshotIntegrityStatus, Verdict } from './types.ts'

/** Check kinds that can, on their own, support `verified`. */
export const VERIFYING_CHECKS = [
  'doi-exists',
  'metadata-match',
  'quote-span',
  'number-match',
  'stat-consistency',
  'artifact-match',
  'retraction',
  'version-match',
] as const satisfies readonly CheckResult['check'][]

/** One bound evidence item, reduced to what the byte checks need. */
export interface ClaimEvidenceText {
  /** The evidence id. */
  readonly evidenceId: string
  /** Decoded text of every textual snapshot (binary snapshots contribute nothing). */
  readonly texts: readonly string[]
  /** Worst integrity state across the evidence's snapshots. */
  readonly integrity: SnapshotIntegrityStatus | 'unknown'
  /** True when the evidence only has snapshots that cannot be read as text. */
  readonly binaryOnly: boolean
}

/** The result of evaluating one claim. */
export interface ClaimEvaluation {
  /** Every check that was run, in a stable order. */
  readonly checks: CheckResult[]
  /** The derived verdict. */
  readonly verdict: Verdict
}

/** One numeric literal found in text. */
export interface NumericToken {
  /** The literal as it appeared. */
  readonly raw: string
  /** Its numeric value. */
  readonly value: number
  /** Its unit suffix (`%`, `‰`) or the empty string. */
  readonly unit: string
}

/**
 * Normalize text for verbatim matching: NFKC (ligatures, full-width digits),
 * zero-width characters removed, whitespace collapsed. Punctuation is left
 * alone — normalizing it away would hide real differences.
 * @param text - the raw text.
 * @returns the normalized text.
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u00AD\u200B-\u200D\uFEFF]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

// Leading character is consumed so a literal is only recognized at a token
// boundary; the thousands form is tried before the plain integer form.
const NUMERIC_TOKEN =
  /(^|[^0-9A-Za-z_.])([+-]?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)(\s?[%‰])?/gu

/**
 * Extract numeric literals from text. Years (bare integers 1900–2099) are
 * skipped: they are overwhelmingly citations of time, not measured values.
 * @param text - the text to scan.
 * @returns every literal in scan order.
 */
export function extractNumericTokens(text: string): NumericToken[] {
  const tokens: NumericToken[] = []
  for (const match of text.matchAll(NUMERIC_TOKEN)) {
    const raw = match[2]
    if (raw === undefined) continue
    const unit = (match[3] ?? '').trim()
    const value = Number(raw.replace(/,/gu, ''))
    if (!Number.isFinite(value)) continue
    const bareInteger = /^[0-9]+$/u.test(raw)
    if (unit === '' && bareInteger && value >= 1900 && value <= 2099) continue
    tokens.push({ raw, value, unit })
  }
  return tokens
}

/** Relative tolerance for comparing two numeric literals. */
const RELATIVE_EPSILON = 1e-9

/**
 * Compare two numeric literals, requiring the same unit.
 * @param left - one literal.
 * @param right - the other literal.
 * @returns whether they denote the same value.
 */
export function numericTokensEqual(left: NumericToken, right: NumericToken): boolean {
  if (left.unit !== right.unit) return false
  if (Number.isInteger(left.value) && Number.isInteger(right.value)) return left.value === right.value
  const scale = Math.max(Math.abs(left.value), Math.abs(right.value), 1)
  return Math.abs(left.value - right.value) <= RELATIVE_EPSILON * scale
}

/** Build one check id that is stable for the same claim and position. */
function checkIdOf(claimId: string, kind: string, index: number): string {
  return stableId('chk', [claimId, kind, index])
}

/**
 * Locate a quote in the evidence texts.
 * @param quote - the exact quote.
 * @param texts - normalized texts.
 * @returns `{found, index}` where index is the normalized offset.
 */
function findQuote(quote: string, texts: readonly string[]): { found: boolean; index: number } {
  const needle = normalizeText(quote)
  if (needle === '') return { found: false, index: -1 }
  for (const text of texts) {
    const haystack = normalizeText(text)
    const index = haystack.indexOf(needle)
    if (index >= 0) return { found: true, index }
  }
  return { found: false, index: -1 }
}

/**
 * Evaluate one claim against its bound evidence.
 * @param claim - the claim (its declared `verdict` is ignored and re-derived).
 * @param evidence - the bound evidence, resolved by the caller.
 * @param anchors - anchors to quote-check (defaults to every evidence anchor).
 * @returns the checks and the derived verdict.
 */
export function evaluateClaim(
  claim: Claim,
  evidence: readonly ClaimEvidenceText[],
  anchors: readonly Anchor[] = [],
): ClaimEvaluation {
  const checks: CheckResult[] = []
  const bound = evidence.length > 0

  checks.push({
    checkId: checkIdOf(claim.claimId, 'evidence-present', 0),
    check: 'evidence-present',
    status: bound ? 'pass' : 'skipped',
    ...(bound ? {} : { code: 'insufficient_evidence' as const }),
    severity: bound ? 'info' : 'warning',
    detail: bound
      ? `bound evidence: ${evidence.map(item => item.evidenceId).join(', ')}`
      : 'no evidence is bound to this claim; nothing can be verified',
  })

  if (!bound) {
    // An unbound claim is unverified — never "false" and never "clean".
    return { checks, verdict: 'unverified' }
  }

  let integrityFailure = false
  let integrityUnknown = false
  for (const [index, item] of evidence.entries()) {
    const ok = item.integrity === 'ok'
    if (item.integrity === 'tampered' || item.integrity === 'missing') integrityFailure = true
    if (item.integrity === 'unknown') integrityUnknown = true
    checks.push({
      checkId: checkIdOf(claim.claimId, 'source-status', index),
      check: 'source-status',
      status: ok ? 'pass' : item.integrity === 'unknown' ? 'skipped' : 'fail',
      ...(ok ? {} : { code: (item.integrity === 'unknown' ? 'unavailable' : 'integrity_mismatch') satisfies CheckCode }),
      severity: ok ? 'info' : item.integrity === 'unknown' ? 'warning' : 'error',
      detail:
        item.integrity === 'ok'
          ? `snapshot bytes of ${item.evidenceId} re-hash to the recorded address`
          : item.integrity === 'unknown'
            ? `snapshot bytes of ${item.evidenceId} could not be read`
            : `snapshot bytes of ${item.evidenceId} are ${item.integrity}`,
    })
  }

  const texts = evidence.flatMap(item => item.texts)
  const binaryOnly = evidence.every(item => item.binaryOnly)
  // Only quotes this claim actually carries are checked: its own locator when
  // it has one, otherwise evidence anchors whose quote appears in the claim
  // text. Unrelated evidence anchors must not poison an unrelated claim.
  const claimText = normalizeText(claim.text)
  const quoteAnchors: Anchor[] = []
  if (claim.locator !== undefined && claim.locator.quote !== undefined && claim.locator.quote !== '') {
    quoteAnchors.push(claim.locator)
  } else {
    for (const anchor of anchors) {
      if (anchor.quote === undefined || anchor.quote === '') continue
      if (claimText.includes(normalizeText(anchor.quote))) quoteAnchors.push(anchor)
    }
  }

  if (quoteAnchors.length === 0) {
    checks.push({
      checkId: checkIdOf(claim.claimId, 'quote-span', 0),
      check: 'quote-span',
      status: 'skipped',
      code: 'not_applicable',
      severity: 'info',
      detail: 'the bound evidence carries no verbatim quote to locate',
    })
  } else {
    for (const [index, anchor] of quoteAnchors.entries()) {
      const quote = anchor.quote ?? ''
      if (integrityFailure) {
        checks.push({
          checkId: checkIdOf(claim.claimId, 'quote-span', index),
          check: 'quote-span',
          status: 'skipped',
          code: 'integrity_mismatch',
          severity: 'warning',
          detail: `quote not checked because the bound snapshot failed its integrity check (${anchor.snapshotId})`,
          locator: anchor,
        })
        continue
      }
      if (texts.length === 0) {
        checks.push({
          checkId: checkIdOf(claim.claimId, 'quote-span', index),
          check: 'quote-span',
          status: 'skipped',
          code: binaryOnly ? 'unsupported_media_type' : 'unavailable',
          severity: 'warning',
          detail: `quote not checkable: no decodable text snapshot for ${anchor.snapshotId}`,
          locator: anchor,
        })
        continue
      }
      const located = findQuote(quote, texts)
      checks.push({
        checkId: checkIdOf(claim.claimId, 'quote-span', index),
        check: 'quote-span',
        status: located.found ? 'pass' : 'fail',
        severity: located.found ? 'info' : 'error',
        detail: located.found
          ? `quote located verbatim at normalized offset ${located.index}`
          : `quote is not present verbatim in any bound snapshot (${anchor.value})`,
        expected: quote.length > 300 ? `${quote.slice(0, 300)}…` : quote,
        actual: { found: located.found, index: located.index },
        locator: anchor,
      })
    }
  }

  const claimedNumbers = extractNumericTokens(claim.text)
  const sourceNumbers = texts.flatMap(text => extractNumericTokens(text))
  if (claimedNumbers.length === 0) {
    if (claim.type === 'number') {
      checks.push({
        checkId: checkIdOf(claim.claimId, 'number-match', 0),
        check: 'number-match',
        status: 'fail',
        code: 'insufficient_evidence',
        severity: 'error',
        detail: 'claim is typed as a number but contains no numeric literal',
      })
    }
  } else if (texts.length === 0) {
    checks.push({
      checkId: checkIdOf(claim.claimId, 'number-match', 0),
      check: 'number-match',
      status: 'skipped',
      code: binaryOnly ? 'unsupported_media_type' : 'unavailable',
      severity: 'warning',
      detail: 'numbers not checkable: no decodable text snapshot',
      expected: claimedNumbers.map(token => token.raw),
    })
  } else {
    const missing = claimedNumbers.filter(
      claimed => !sourceNumbers.some(candidate => numericTokensEqual(claimed, candidate)),
    )
    checks.push({
      checkId: checkIdOf(claim.claimId, 'number-match', 0),
      check: 'number-match',
      status: missing.length === 0 ? 'pass' : 'fail',
      severity: missing.length === 0 ? 'info' : 'error',
      detail:
        missing.length === 0
          ? `all ${claimedNumbers.length} numeric literal(s) occur verbatim in the bound snapshots`
          : `${missing.length} of ${claimedNumbers.length} numeric literal(s) do not occur in the bound snapshots`,
      expected: claimedNumbers.map(token => token.raw),
      actual: { missing: missing.map(token => token.raw), sourceTokens: sourceNumbers.length },
    })
  }

  const failOf = (kind: CheckResult['check']): boolean =>
    checks.some(check => check.check === kind && check.status === 'fail')
  const substantivePass = checks.some(
    check => check.status === 'pass' && (VERIFYING_CHECKS as readonly string[]).includes(check.check),
  )
  const passOf = (kind: CheckResult['check']): boolean =>
    checks.some(check => check.check === kind && check.status === 'pass')

  let verdict: Verdict
  if (integrityFailure) verdict = 'contradicted'
  else if (failOf('quote-span')) verdict = 'disproven'
  else if (failOf('number-match')) verdict = 'insufficient'
  else if (!substantivePass) verdict = 'insufficient'
  else if (integrityUnknown && !passOf('source-status')) verdict = 'insufficient'
  else verdict = 'verified'

  if (verdict === 'insufficient' && !checks.some(check => check.code === 'insufficient_evidence')) {
    checks.push({
      checkId: checkIdOf(claim.claimId, 'other', 0),
      check: 'other',
      status: 'skipped',
      code: 'insufficient_evidence',
      severity: 'warning',
      detail:
        'nothing checkable was found: bind evidence carrying a verbatim quote or a numeric literal the source actually contains',
    })
  }

  return { checks, verdict }
}

/**
 * Apply a claim's declared verdict/checks to the schema invariants before the
 * value is written. Returns the violated invariant messages (empty = valid).
 * @param claim - the claim as it would be stored.
 * @returns one message per violated invariant.
 */
export function claimInvariantViolations(claim: Claim): string[] {
  const violations: string[] = []
  const verdict = claim.verdict
  if (verdict === undefined) return violations
  if (claim.checks.length === 0) violations.push('a claim with a verdict must carry at least one check')
  if (verdict === 'verified') {
    if (claim.evidenceRefs.length === 0) violations.push('a verified claim must bind at least one evidence item')
    const passing = claim.checks.some(
      check => check.status === 'pass' && (VERIFYING_CHECKS as readonly string[]).includes(check.check),
    )
    if (!passing) violations.push('a verified claim needs at least one passing verifying check')
    if (claim.checks.some(check => check.status === 'fail')) {
      violations.push('a verified claim must not carry a failing check')
    }
  }
  if ((verdict === 'contradicted' || verdict === 'disproven') && !claim.checks.some(check => check.status === 'fail' || check.status === 'warn')) {
    violations.push(`a ${verdict} claim must carry a failing or warning check`)
  }
  if (verdict === 'insufficient') {
    const explained = claim.checks.some(
      check =>
        check.status === 'skipped' ||
        check.status === 'warn' ||
        check.code === 'insufficient_evidence' ||
        check.code === 'not_found' ||
        check.code === 'ambiguous_match',
    )
    if (!explained) violations.push('an insufficient claim must carry a skipped/warning check explaining why')
  }
  return violations
}
