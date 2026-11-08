#!/usr/bin/env node
/**
 * `dsh-rep-verify` executable entry. Kept separate from `cli.ts` so the CLI
 * logic is importable by tests and the bin always runs (a `import.meta.url`
 * main-guard breaks under `node_modules/.bin` symlinks).
 *
 * @module @perrylink/dsh-research-core/bin
 */

import { runCli } from './cli.ts'

process.exitCode = await runCli(process.argv.slice(2))
