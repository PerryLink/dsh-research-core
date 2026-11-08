/**
 * Version single-sourcing: `VERSION` must equal the published package version,
 * and the package manifest must keep the DSH contract fields the loader reads.
 * @module test/version.spec
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REP_SCHEMA_VERSION } from '../src/schema.ts'
import { VERSION } from '../src/version.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Read and parse one JSON file. */
async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
}

describe('package contract', () => {
  it('VERSION matches package.json', async () => {
    const pkg = await readJson(path.join(here, '..', 'package.json'))
    expect(pkg['version']).toBe(VERSION)
  })

  it('declares the bundle patch the Loader reads', async () => {
    const pkg = await readJson(path.join(here, '..', 'package.json'))
    expect(pkg['type']).toBe('module')
    expect(pkg['dsh']).toEqual({ manifestVersion: 1, bundle: { patch: './cordis.patch.yml' } })
    expect(Array.isArray(pkg['files'])).toBe(true)
    expect(pkg['files']).toContain('schema')
    expect(pkg['files']).toContain('cordis.patch.yml')
  })

  it('declares the current DSH peer line without pretending older ones', async () => {
    const pkg = await readJson(path.join(here, '..', 'package.json'))
    const engines = pkg['engines'] as Record<string, string>
    const peers = pkg['peerDependencies'] as Record<string, string>
    expect(engines['dsh']).toContain('>=0.2.1-0 <0.3.0')
    expect(engines['dsh']).toContain('>=0.2.2-0 <0.3.0')
    expect(engines['node']).toBe('^22.19.0 || >=24.9.0')
    expect(peers['@deepseek-ai/cordis']).toBeDefined()
    expect(peers['@deepseek-ai/schemastery']).toBeDefined()
    expect(pkg['dependencies']).toEqual({})
  })

  it('publishes a schema whose $id and version agree with the module', async () => {
    const schema = await readJson(path.join(here, '..', 'schema', 'rep-v1.schema.json'))
    expect(schema['$id']).toBe('https://raw.githubusercontent.com/PerryLink/dsh-research-core/main/schema/rep-v1.schema.json')
    expect(REP_SCHEMA_VERSION).toBe(1)
    expect((schema['properties'] as Record<string, unknown>)['schemaVersion']).toEqual({ const: 1 })
  })
})
