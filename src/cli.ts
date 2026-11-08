/**
 * `dsh-rep-verify` implementation — the independent REP record verifier.
 *
 * Anyone can run this on a `.rep.json` file plus its object store and recompute
 * every snapshot hash, every seed of the manifest seal, and every invariant. It
 * never trusts the producer and never repairs a mismatch.
 *
 * Exit codes: 0 = verified, 1 = verification failed, 2 = usage / IO error.
 *
 * @module @perrylink/dsh-research-core/cli
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { sha256Hex } from './hash.ts'
import { validationToSarif } from './sarif.ts'
import type { ResearchRecord } from './types.ts'
import { verifyRecord, type RecordVerification } from './verify.ts'
import { VERSION } from './version.ts'

/** Output sinks (injectable so the CLI is testable). */
export interface CliIo {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

/** The default sinks. */
export const processIo: CliIo = {
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
}

/** Parsed command line. */
export interface CliArgs {
  readonly file?: string
  readonly objectsDir?: string
  readonly json: boolean
  readonly sarif: boolean
  readonly help: boolean
  readonly version: boolean
}

/** The usage text. */
export const USAGE = `dsh-rep-verify ${VERSION} — verify a REP v1 record without trusting its producer

Usage:
  dsh-rep-verify <record.rep.json> [options]

Options:
  --objects <dir>   content-addressed objects/ directory used to re-hash snapshots
  --json            machine-readable verification report
  --sarif           SARIF 2.1.0 output (for CI / code scanning)
  --version         print the verifier version
  -h, --help        show this help

Without --objects the record's invariants and manifest seal are still checked,
but snapshot hashes are reported as "not_checked" — the verifier never pretends
it verified bytes it did not read.

Exit codes: 0 verified · 1 verification failed · 2 usage/IO error.
`

/**
 * Parse argv.
 * @param argv - arguments after the executable.
 * @returns the parsed arguments.
 * @throws Error on an unknown option or a missing value.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  const flags = new Set<string>()
  let file: string | undefined
  let objectsDir: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--json' || arg === '--sarif' || arg === '-h' || arg === '--help' || arg === '--version') {
      flags.add(arg)
    } else if (arg === '--objects') {
      const next = argv[index + 1]
      if (next === undefined) throw new Error('--objects requires a directory')
      objectsDir = next
      index += 1
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option ${arg}`)
    } else if (file === undefined) {
      file = arg
    } else {
      throw new Error(`unexpected argument ${arg}`)
    }
  }
  return {
    ...(file === undefined ? {} : { file }),
    ...(objectsDir === undefined ? {} : { objectsDir }),
    json: flags.has('--json'),
    sarif: flags.has('--sarif'),
    help: flags.has('-h') || flags.has('--help'),
    version: flags.has('--version'),
  }
}

/**
 * Render the human-readable verdict.
 * @param file - the record path.
 * @param fileHash - SHA-256 of the file bytes.
 * @param record - the parsed record.
 * @param verification - the verification report.
 * @returns the text block.
 */
export function renderHuman(
  file: string,
  fileHash: string,
  record: ResearchRecord,
  verification: RecordVerification,
): string {
  const lines: string[] = []
  lines.push(`record     ${record.recordId ?? '(unknown)'}`)
  lines.push(`file       ${file}`)
  lines.push(`file sha256 ${fileHash}`)
  if (record.manifest?.integrity !== undefined) {
    lines.push(`manifest   ${record.manifest.integrity.manifestHash} (${record.manifest.integrity.algorithm})`)
  }
  if (verification.manifestSeal !== undefined) {
    lines.push(`seal       ${verification.manifestSeal.ok ? 'recomputed OK' : 'MISMATCH'}`)
  }
  const checked = verification.snapshots.filter(item => item.status !== 'not_checked')
  if (checked.length === 0) {
    lines.push('snapshots  not checked (pass --objects <dir> to re-hash the stored bytes)')
  } else {
    const ok = checked.filter(item => item.status === 'ok').length
    const missing = checked.filter(item => item.status === 'missing').length
    const tampered = checked.filter(item => item.status === 'tampered').length
    lines.push(`snapshots  ${ok} ok · ${missing} missing · ${tampered} tampered`)
  }
  if (verification.anchors.length > 0) {
    const found = verification.anchors.filter(anchor => anchor.found).length
    lines.push(`quotes     ${found}/${verification.anchors.length} re-located verbatim`)
  }
  const errors = verification.issues.filter(issue => issue.severity === 'error')
  const warnings = verification.issues.filter(issue => issue.severity === 'warning')
  lines.push(`issues     ${errors.length} error(s) · ${warnings.length} warning(s)`)
  for (const issue of errors.slice(0, 40)) lines.push(`  ✗ ${issue.code} ${issue.path}: ${issue.message}`)
  if (errors.length > 40) lines.push(`  … ${errors.length - 40} more error(s)`)
  lines.push(verification.ok ? 'RESULT     verified' : 'RESULT     FAILED')
  return lines.join('\n')
}

/**
 * CLI entry.
 * @param argv - arguments after the executable.
 * @param io - output sinks.
 * @returns the process exit code.
 */
export async function runCli(argv: readonly string[], io: CliIo = processIo): Promise<number> {
  let args: CliArgs
  try {
    args = parseArgs(argv)
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\n${USAGE}`)
    return 2
  }
  if (args.help) {
    io.stdout(USAGE)
    return 0
  }
  if (args.version) {
    io.stdout(`${VERSION}\n`)
    return 0
  }
  if (args.file === undefined) {
    io.stderr(`missing record file\n\n${USAGE}`)
    return 2
  }
  const file = path.resolve(args.file)
  let bytes: Buffer
  try {
    bytes = await readFile(file)
  } catch (error) {
    io.stderr(`cannot read ${file}: ${(error as Error).message}\n`)
    return 2
  }
  const fileHash = sha256Hex(bytes)
  let record: ResearchRecord
  try {
    record = JSON.parse(bytes.toString('utf8')) as ResearchRecord
  } catch (error) {
    io.stderr(`${file} is not valid JSON: ${(error as Error).message}\n`)
    return 2
  }
  const verification = await verifyRecord(
    record,
    args.objectsDir === undefined ? {} : { objectsDir: path.resolve(args.objectsDir) },
  )
  if (args.sarif) {
    const log = validationToSarif(
      verification.issues.map(issue => ({ ...issue })),
      { version: VERSION, informationUri: 'https://github.com/PerryLink/dsh-research-core' },
    )
    io.stdout(`${JSON.stringify(log, null, 2)}\n`)
  } else if (args.json) {
    io.stdout(`${JSON.stringify({ file, fileHash, verification }, null, 2)}\n`)
  } else {
    io.stdout(`${renderHuman(file, fileHash, record, verification)}\n`)
  }
  return verification.ok ? 0 : 1
}
