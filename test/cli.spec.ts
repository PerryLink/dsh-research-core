/**
 * The independent verifier CLI: exit codes, honest "not checked" reporting,
 * tamper detection, and machine-readable output.
 * @module test/cli.spec
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCli, type CliIo } from '../src/cli.ts'
import { hashRefHex } from '../src/hash.ts'
import type { HashRef, ResearchRecord } from '../src/types.ts'
import { VERSION } from '../src/version.ts'
import { ARTICLE_TEXT } from './fixtures/index.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name: string): string => path.join(here, 'fixtures', name)

/** Capture CLI output. */
function io(): CliIo & { out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return { out, err, stdout: text => out.push(text), stderr: text => err.push(text) }
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'rep-cli-'))
})

afterEach(async () => {
  if (root.startsWith(tmpdir())) await rm(root, { recursive: true, force: true })
})

/** Materialize the fixture's objects into a directory. */
async function objectsFor(recordPath: string): Promise<{ dir: string; snapshotId: HashRef }> {
  const record = JSON.parse(await readFile(recordPath, 'utf8')) as ResearchRecord
  const snapshotId = record.snapshots[0]!.snapshotId
  const dir = path.join(root, 'objects')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, hashRefHex(snapshotId)), ARTICLE_TEXT, 'utf8')
  return { dir, snapshotId }
}

describe('dsh-rep-verify', () => {
  it('prints usage and exits 0 for --help', async () => {
    const sink = io()
    expect(await runCli(['--help'], sink)).toBe(0)
    expect(sink.out.join('')).toContain('dsh-rep-verify')
    expect(sink.out.join('')).toContain('not_checked')
  })

  it('prints the version and exits 0 for --version', async () => {
    const sink = io()
    expect(await runCli(['--version'], sink)).toBe(0)
    expect(sink.out.join('').trim()).toBe(VERSION)
  })

  it('exits 2 on missing arguments, unknown options and unreadable files', async () => {
    const sink = io()
    expect(await runCli([], sink)).toBe(2)
    expect(await runCli(['--nope'], sink)).toBe(2)
    expect(await runCli(['--objects'], sink)).toBe(2)
    expect(await runCli([path.join(root, 'missing.rep.json')], sink)).toBe(2)
  })

  it('exits 2 on invalid JSON', async () => {
    const file = path.join(root, 'bad.rep.json')
    await writeFile(file, '{not json', 'utf8')
    const sink = io()
    expect(await runCli([file], sink)).toBe(2)
    expect(sink.err.join('')).toContain('not valid JSON')
  })

  it('verifies a sealed record without objects, reporting hashes as not checked', async () => {
    const sink = io()
    expect(await runCli([fixture('valid-sealed.rep.json')], sink)).toBe(0)
    const text = sink.out.join('')
    expect(text).toContain('RESULT     verified')
    expect(text).toContain('snapshots  not checked')
    expect(text).toContain('seal       recomputed OK')
  })

  it('re-hashes the objects directory and re-locates every quote', async () => {
    const recordPath = fixture('valid-sealed.rep.json')
    const { dir } = await objectsFor(recordPath)
    const sink = io()
    expect(await runCli([recordPath, '--objects', dir], sink)).toBe(0)
    const text = sink.out.join('')
    expect(text).toContain('snapshots  1 ok')
    expect(text).toContain('quotes     1/1 re-located verbatim')
  })

  it('fails (exit 1) when a stored object was tampered with', async () => {
    const recordPath = fixture('valid-sealed.rep.json')
    const { dir, snapshotId } = await objectsFor(recordPath)
    await writeFile(path.join(dir, hashRefHex(snapshotId)), 'different bytes', 'utf8')
    const sink = io()
    expect(await runCli([recordPath, '--objects', dir], sink)).toBe(1)
    const text = sink.out.join('')
    expect(text).toContain('1 tampered')
    expect(text).toContain('verify.snapshot_hash_mismatch')
    expect(text).toContain('RESULT     FAILED')
  })

  it('fails (exit 1) when a stored object is missing', async () => {
    const recordPath = fixture('valid-sealed.rep.json')
    const { dir } = await objectsFor(recordPath)
    await rm(path.join(dir, hashRefHex(JSON.parse(await readFile(recordPath, 'utf8')).snapshots[0].snapshotId)), { force: true })
    const sink = io()
    expect(await runCli([recordPath, '--objects', dir], sink)).toBe(1)
    expect(sink.out.join('')).toContain('verify.snapshot_missing')
  })

  it('emits a machine-readable report with --json', async () => {
    const sink = io()
    expect(await runCli([fixture('valid-sealed.rep.json'), '--json'], sink)).toBe(0)
    const parsed = JSON.parse(sink.out.join('')) as { fileHash: string; verification: { ok: boolean; manifestSeal: { ok: boolean } } }
    expect(parsed.fileHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(parsed.verification.ok).toBe(true)
    expect(parsed.verification.manifestSeal.ok).toBe(true)
  })

  it('emits SARIF with --sarif', async () => {
    const sink = io()
    expect(await runCli([fixture('invalid-manifest-seal.rep.json'), '--sarif'], sink)).toBe(1)
    const sarif = JSON.parse(sink.out.join('')) as { version: string; runs: Array<{ results: unknown[] }> }
    expect(sarif.version).toBe('2.1.0')
    expect(sarif.runs[0]!.results.length).toBeGreaterThan(0)
  })
})
