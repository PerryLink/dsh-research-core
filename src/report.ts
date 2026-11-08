/**
 * Human-readable rendering of a REP record.
 *
 * The JSON record is the machine contract; this renderer is the companion
 * report a human reads. Every finding shows the locator, the reported value and
 * the recomputed/expected value so a reviewer can check it in under a minute.
 *
 * @module @perrylink/dsh-research-core/report
 */

import { evidenceStatusOf } from './manifest.ts'
import type { CheckResult, ResearchRecord, Verdict } from './types.ts'

/** Verdict markers used in rendered text. */
export const VERDICT_MARK: Readonly<Record<Verdict, string>> = {
  verified: '✅ verified',
  unverified: '⚪ unverified',
  insufficient: '🟡 insufficient',
  contradicted: '⛔ contradicted',
  disproven: '❌ disproven',
}

/** Render an unknown value compactly for a table cell. */
function show(value: unknown): string {
  if (value === undefined) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const flat = text.replace(/\s+/gu, ' ')
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat
}

/** Escape a markdown table cell. */
function cell(value: string): string {
  return value.replace(/\|/gu, '\\|').replace(/\n/gu, ' ')
}

/** Render one check as a table row. */
function checkRow(check: CheckResult): string {
  const locator = check.locator === undefined ? '' : `${check.locator.kind}:${check.locator.value}`
  return `| \`${check.check}\` | ${check.status}${check.code === undefined ? '' : ` (\`${check.code}\`)`} | ${cell(locator)} | ${cell(check.detail)} | ${cell(show(check.expected))} | ${cell(show(check.actual))} |`
}

/**
 * Render a record as Markdown.
 * @param record - the REP record.
 * @returns the human-readable report.
 */
export function renderRecordMarkdown(record: ResearchRecord): string {
  const manifest = record.manifest
  const counts = manifest?.summary.verdictCounts
  const lines: string[] = []
  lines.push(`# ${manifest?.title ?? `REP record ${record.recordId}`}`)
  lines.push('')
  if (manifest !== undefined) {
    lines.push(`**Topic:** ${manifest.topic}  `)
  }
  lines.push(`**Record:** \`${record.recordId}\` · **schema:** REP v${record.schemaVersion} · **created:** ${record.createdAt}  `)
  if (record.generator !== undefined) {
    lines.push(`**Generator:** ${record.generator.name}@${record.generator.version}  `)
  }
  if (manifest?.integrity !== undefined) {
    lines.push(`**Manifest seal (sha256):** \`${manifest.integrity.manifestHash}\`  `)
  }
  lines.push('')

  lines.push('## Summary')
  lines.push('')
  lines.push('| Snapshots | Evidence | Claims | Verified | Insufficient | Unverified | Contradicted | Disproven | Failed checks | Not found |')
  lines.push('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
  const summary = manifest?.summary
  lines.push(
    `| ${record.snapshots.length} | ${record.evidence.length} | ${record.claims.length} | ${counts?.verified ?? 0} | ${counts?.insufficient ?? 0} | ${counts?.unverified ?? 0} | ${counts?.contradicted ?? 0} | ${counts?.disproven ?? 0} | ${summary?.failedChecks ?? 0} | ${summary?.notFoundChecks ?? 0} |`,
  )
  lines.push('')
  if ((summary?.notFoundChecks ?? 0) > 0) {
    lines.push('> `not_found` means the source could not be located. It is **not** evidence of fabrication and **not** evidence of cleanliness.')
    lines.push('')
  }

  lines.push('## Evidence')
  lines.push('')
  lines.push('| Evidence | Source | Status | Snapshots | Title |')
  lines.push('|---|---|---|---:|---|')
  for (const evidence of record.evidence) {
    const status = evidenceStatusOf(evidence)
    lines.push(
      `| \`${evidence.evidenceId}\` | ${evidence.sourceRef.kind}:${cell(evidence.sourceRef.id)} | ${status} | ${evidence.snapshotIds.length} | ${cell(evidence.title ?? '')} |`,
    )
  }
  lines.push('')

  const evidenceChecks = record.evidence.flatMap(evidence => (evidence.checks ?? []).map(check => ({ evidence, check })))
  if (evidenceChecks.length > 0) {
    lines.push('### Source checks')
    lines.push('')
    lines.push('| Check | Status | Locator | Detail | Expected | Actual |')
    lines.push('|---|---|---|---|---|---|')
    for (const { check } of evidenceChecks) lines.push(checkRow(check))
    lines.push('')
  }

  lines.push('## Claims')
  lines.push('')
  for (const claim of record.claims) {
    const verdict = claim.verdict ?? 'unverified'
    lines.push(`### ${VERDICT_MARK[verdict]} — \`${claim.claimId}\``)
    lines.push('')
    lines.push(`> ${claim.text.replace(/\n/gu, ' ')}`)
    lines.push('')
    if (claim.evidenceRefs.length > 0) {
      lines.push(`Bound evidence: ${claim.evidenceRefs.map(id => `\`${id}\``).join(', ')}`)
      lines.push('')
    }
    if (claim.checks.length > 0) {
      lines.push('| Check | Status | Locator | Detail | Expected | Actual |')
      lines.push('|---|---|---|---|---|---|')
      for (const check of claim.checks) lines.push(checkRow(check))
      lines.push('')
    }
  }

  if (record.artifacts !== undefined && record.artifacts.length > 0) {
    lines.push('## Artifacts')
    lines.push('')
    lines.push('| Artifact | Kind | Hash | Path |')
    lines.push('|---|---|---|---|')
    for (const artifact of record.artifacts) {
      lines.push(`| \`${artifact.artifactId}\` | ${artifact.kind} | \`${artifact.hash}\` | ${cell(artifact.path ?? '')} |`)
    }
    lines.push('')
  }

  if (manifest?.limitations !== undefined && manifest.limitations.length > 0) {
    lines.push('## Limitations')
    lines.push('')
    for (const limitation of manifest.limitations) lines.push(`- ${limitation}`)
    lines.push('')
  }

  if (record.notes !== undefined && record.notes.length > 0) {
    lines.push('## Notes')
    lines.push('')
    for (const note of record.notes) lines.push(`- ${note}`)
    lines.push('')
  }

  return `${lines.join('\n')}\n`
}

/** Alias kept for symmetry with the JSON emitter naming used by plugins. */
export const renderReportMarkdown = renderRecordMarkdown
