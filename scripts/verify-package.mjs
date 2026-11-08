// Post-build package gate: everything the published artifact promises must
// exist on disk, parse, and be covered by package.json#files.
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const fail = message => {
  console.error(`verify-package: ${message}`)
  process.exit(1)
}

const required = ['lib/index.js', 'lib/index.d.ts', 'lib/bin.js', 'schema/rep-v1.schema.json', 'cordis.patch.yml', 'README.md', 'README-zh.md', 'CHANGELOG.md', 'LICENSE']
for (const file of required) {
  if (!existsSync(path.join(root, file))) fail(`missing ${file} (run pnpm run build)`)
}

// files[] must cover every runtime entry point a consumer can resolve.
const files = pkg.files ?? []
for (const entry of ['lib', 'schema', 'cordis.patch.yml']) {
  if (!files.includes(entry)) fail(`package.json#files does not publish ${entry}`)
}

const bin = pkg.bin?.['dsh-rep-verify']
if (bin !== './lib/bin.js') fail(`unexpected bin mapping: ${String(bin)}`)
const shebang = readFileSync(path.join(root, 'lib/bin.js'), 'utf8').split('\n')[0]
if (shebang !== '#!/usr/bin/env node') fail(`lib/bin.js must start with a node shebang, got ${String(shebang)}`)

const schema = JSON.parse(readFileSync(path.join(root, 'schema/rep-v1.schema.json'), 'utf8'))
if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') fail('schema must target JSON Schema 2020-12')
for (const def of ['SourceRef', 'Snapshot', 'Anchor', 'Evidence', 'Claim', 'CheckResult', 'Artifact', 'AuditEvent', 'ReportManifest']) {
  if (schema.$defs?.[def] === undefined) fail(`schema is missing $defs/${def}`)
}
if (schema.properties?.schemaVersion?.const !== 1) fail('schema must pin schemaVersion to 1')

if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') fail('package.json#dsh.bundle.patch must point at cordis.patch.yml')
if (pkg.dependencies === undefined || Object.keys(pkg.dependencies).length !== 0) fail('runtime dependencies must stay empty')

console.log('verify-package: ok (required files present, 9 required schema defs, zero runtime dependencies)')
