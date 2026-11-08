/**
 * Golden fixtures: the committed JSON must equal what the generator produces
 * from the real core functions, every expectation must hold, and the published
 * JSON Schema must agree with the structural verdict.
 *
 * Regenerate with `UPDATE_FIXTURES=1 pnpm test`.
 * @module test/fixtures.spec
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'
import { canonicalJson } from '../src/canonical.ts'
import { getRepSchema } from '../src/schema.ts'
import { validateRep } from '../src/validate.ts'
import { buildFixtures } from './fixtures/index.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureDir = path.join(here, 'fixtures')
const specs = buildFixtures()

describe('golden fixtures', () => {
  it('committed JSON matches the generator (run UPDATE_FIXTURES=1 pnpm test after editing fixtures)', async () => {
    if (process.env['UPDATE_FIXTURES'] === '1') {
      await mkdir(fixtureDir, { recursive: true })
      for (const spec of specs) {
        await writeFile(path.join(fixtureDir, spec.file), `${JSON.stringify(spec.value, null, 2)}\n`, 'utf8')
      }
    }
    for (const spec of specs) {
      const text = await readFile(path.join(fixtureDir, spec.file), 'utf8')
      expect(canonicalJson(JSON.parse(text)), `${spec.file}: regenerate with UPDATE_FIXTURES=1`).toBe(
        canonicalJson(spec.value),
      )
    }
    expect(specs).toHaveLength(20)
  })

  it('every fixture declares a unique file name', () => {
    const names = new Set(specs.map(spec => spec.file))
    expect(names.size).toBe(specs.length)
  })

  for (const spec of specs) {
    it(`${spec.file} — ${spec.about}`, async () => {
      const value: unknown = JSON.parse(await readFile(path.join(fixtureDir, spec.file), 'utf8'))
      const result = validateRep(value)
      expect(result.ok, `${spec.file}: expected ok=${String(spec.expect.valid)}, got ${JSON.stringify(result.issues)}`).toBe(
        spec.expect.valid,
      )
      const codes = new Set(result.issues.map(issue => issue.code))
      for (const code of spec.expect.codes) {
        expect(codes, `${spec.file}: missing expected issue code ${code} (got ${[...codes].join(', ')})`).toContain(code)
      }
    })
  }

  it('the published JSON Schema agrees with the structural expectations', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true })
    const validate = ajv.compile(getRepSchema())
    for (const spec of specs) {
      if (spec.expect.schema === 'either') continue
      const ok = validate(spec.value) as boolean
      expect(ok, `${spec.file}: schema ${spec.expect.schema === 'accept' ? 'must accept' : 'must reject'} (${ajv.errorsText(validate.errors)})`).toBe(
        spec.expect.schema === 'accept',
      )
    }
  })
})
