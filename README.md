# @perrylink/dsh-research-core

**REP v1 — the shared Research Evidence Protocol for the DSH research plugin family.**

*One protocol, one store, one verifier. Every research plugin speaks the same evidence language, and anyone can recompute what it claims.*

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24.9-brightgreen.svg)]()
[![DSH plugin](https://img.shields.io/badge/dsh--plugin-✅-green)](https://github.com/topics/dsh-plugin)

English · [简体中文](README-zh.md)

---

## What this is

`dsh-research-core` is the **shared layer** under a family of 18 small, independently installable research plugins. It does three things and nothing else:

1. **Defines REP v1** — a JSON Schema + TypeScript types for `SourceRef`, `Snapshot`, `Anchor`, `Evidence`, `Claim`, `CheckResult`, `Artifact`, `AuditEvent` and `ReportManifest`, wrapped in one `ResearchRecord` interchange file (`.rep.json`).
2. **Provides deterministic primitives** — SHA-256 content addressing, canonical JSON, stable ids, invariant validation, byte-level record verification, manifest sealing, hash-chained audit events, SARIF 2.1.0 export.
3. **Mounts an optional local service** (`ctx.researchEvidence`) backed by a content-addressed store, plus a structural bridge to the existing `dsh-research-report` ledger (`ctx.researchReport`).

```
plugin output ──► REP record (.rep.json) ──► dsh-rep-verify ──► verified / failed
                        │
                        ├── schema/rep-v1.schema.json   (the contract)
                        ├── objects/<sha256>            (immutable bytes)
                        └── manifest seal               (sha256 of canonical JSON)
```

## What this is not

- **Not a retriever.** No Crossref, no PubMed, no PDF parsing — those are the plugins.
- **Not a checker.** It does not decide whether a claim is *semantically* supported; it guarantees the bytes, the locators and the verdict bookkeeping are reproducible.
- **Not a workbench.** No UI, no reader, no editor.
- **Not a wrapper around `dsh-research-report`.** That plugin keeps `ctx.researchReport` and its byte-frozen `assemble` contract; core adapts to it and never rewrites it.

## Compatibility

| | |
|---|---|
| DeepSeek Harness | **`dsh-v0.2.1-rc.5`** (verified on this machine, 2026-11-08) — npm peer line `>=0.2.1-0 <0.3.0 \|\| >=0.2.2-0 <0.3.0` |
| Node | `^22.19.0 \|\| >=24.9.0` (tested on `24.22.1`), ESM only |
| Peers | `@deepseek-ai/cordis ^4.0.5-alpha.1`, `@deepseek-ai/schemastery ^3.18.5-alpha.1` |
| Runtime dependencies | **zero** |

## Install

```sh
# npm channel
dsh plugin --profile <name> add @perrylink/dsh-research-core

# git channel (pin a commit)
dsh plugin --profile <name> add github:PerryLink/dsh-research-core#<commit-sha>

# local checkout (development / smoke)
dsh plugin --profile <name> add file:/absolute/path/to/dsh-research-core
```

Verify the row mounts:

```sh
dsh --profile <name> --dump-config | grep dsh-research-core
```

Uninstall:

```sh
dsh plugin --profile <name> remove @perrylink/dsh-research-core
```

Mounting is optional for consumers: the package also works as a plain library (`import { validateRep } from '@perrylink/dsh-research-core'`), so a plugin can use REP without depending on the service being mounted.

## The protocol (REP v1)

| Entity | Purpose | Hard invariant |
|---|---|---|
| `SourceRef` | where evidence came from (`doi` / `pmid` / `pmcid` / `arxiv` / `isbn` / `url` / `file` / `dataset` / `other`) | the id pattern is enforced per kind |
| `Snapshot` | immutable, content-addressed bytes | `snapshotId = "sha256:<hex>"`; `path` MUST equal `objects/<hex>` |
| `Anchor` | a locator into one snapshot (`page` / `section` / `paragraph` / `char` / `table` / `figure` / `record`) | kind-specific fields and canonical `value` forms (`p.3`, `c.10-40`, `para.7`, `t.2`, `f.1`, `field:title`) |
| `Evidence` | source + snapshot(s) + anchor(s) + provenance (+ checks) | **at least one snapshot and one anchor; evidence without a snapshot is invalid** |
| `CheckResult` | one deterministic check outcome (`pass`/`fail`/`warn`/`skipped`) with a stable `code` | `code:"not_found"` MUST be `skipped` |
| `Claim` | an assertion, its evidence bindings, its checks, its verdict | **a verdict requires ≥1 check; `verified` requires ≥1 evidence, ≥1 passing verifying check and no failing check** |
| `Artifact` | code / env / data / seed / command / figure / table | `sha256:<hex>` content hash |
| `AuditEvent` | append-only, hash-chained event | `hash = sha256(canonicalJson(event minus hash))`; `prevHash` links the chain |
| `ReportManifest` | the sealed report summary | `integrity.manifestHash = sha256(canonicalJson(manifest minus integrity))` |

### Verdict semantics (important)

| Verdict | Means | Does **not** mean |
|---|---|---|
| `verified` | the checkable literals (quotes/numbers/metadata) were found and every bound snapshot re-hashes | the claim is *true* in a semantic sense |
| `unverified` | nothing was checked (typically: no evidence bound) | false |
| `insufficient` | the available evidence cannot decide it (e.g. a number could be computed, not quoted) | false, and **not** "clean" |
| `contradicted` | a bound snapshot failed its integrity check, or a numeric bridge disagrees | — |
| `disproven` | the source text explicitly does not contain the asserted quote | — |

`not_found` is a **check code**, not a verdict. It means *the source could not be located*. It is **not** evidence of fabrication and **not** evidence of cleanliness. It is always recorded as `skipped`, and an evidence item whose only outcome is `not_found` stays `unchecked` — never `ok`.

### Canonical hashing

All REP hashes are computed over canonical JSON: object keys sorted by UTF-16 code unit, ECMAScript number serialization, no insignificant whitespace, `undefined` properties omitted, non-finite numbers / bigints / cycles / lone surrogates rejected. This follows RFC 8785 (JCS) for well-formed values.

## Quick start (library)

```ts
import {
  buildManifest, sealManifest, validateRep, verifyManifestSeal,
  snapshotIdOf, canonicalJson, toSarif, renderRecordMarkdown,
} from '@perrylink/dsh-research-core'

const snapshot = {
  snapshotId: snapshotIdOf(bytes),
  mediaType: 'text/plain' as const,
  bytes: bytes.byteLength,
  path: `objects/${snapshotIdOf(bytes).slice('sha256:'.length)}`,
  capturedAt: '2026-01-15T10:00:00.000Z',
  sourceRef: { kind: 'file' as const, id: 'paper.txt', retrievedAt: '2026-01-15T10:00:00.000Z' },
}
// …build evidence/claims, then:
const result = validateRep(record)            // invariants, cross-refs, audit chain, seal
const sarif = toSarif(record, { version: '1.0.0' })
const markdown = renderRecordMarkdown(record)
```

## Quick start (service)

```ts
// inside a research plugin that optionally injects researchEvidence
const service = ctx.get('researchEvidence') as ResearchEvidenceService | undefined
if (service !== undefined) {
  const { snapshot } = await service.capture({
    bytes: pdfBytes, mediaType: 'application/pdf',
    sourceRef: { kind: 'file', id: 'paper.pdf', retrievedAt: new Date().toISOString() },
  })
  await service.addEvidence({ sourceRef, snapshotIds: [snapshot.snapshotId], anchors, provenance })
  await service.addClaim({ text, type: 'result', evidenceRefs: [evidenceId], locator })
  const claim = await service.verifyClaim(claimId)       // records the verdict
  const sealed = await service.seal({ title, topic, generator })
  await service.verifyRecord(sealed.record)              // independent re-check
}
```

## CLI — independent verification

```sh
dsh-rep-verify <record.rep.json> [--objects <dir>] [--json] [--sarif]
```

```text
record     rec-fixture-sealed
manifest   9425dcf5… (sha256)
seal       recomputed OK
snapshots  1 ok · 0 missing · 0 tampered
quotes     1/1 re-located verbatim
issues     0 error(s) · 0 warning(s)
RESULT     verified
```

Exit codes: `0` verified · `1` verification failed · `2` usage/IO error.
Without `--objects` the record's invariants and seal are still checked, but snapshot hashes are reported as `not_checked` — the CLI never pretends it verified bytes it did not read.

## Tools & surfaces

This package registers **no model-facing tools** by design (the 18 plugins own the tools). Its surfaces are:

| Surface | Name | Notes |
|---|---|---|
| Service | `ctx.researchEvidence` | 15 methods: `capture`, `addEvidence`, `setEvidenceChecks`, `addClaim`, `setVerdict`, `verifyClaim`, `getSnapshot`, `getEvidence`, `getClaim`, `listSnapshots`, `listEvidence`, `listClaims`, `buildRecord`, `seal`, `verifyRecord`, plus `attachReport` / `importReportEvidence` / `mirrorToReport` |
| CLI | `dsh-rep-verify` | exit-code driven, `--json` / `--sarif` |
| Schema | `./schema/rep-v1.schema.json` | JSON Schema 2020-12, `$id` published |
| Events | `RESEARCH_EVENTS` | `research/evidence.captured`, `research/claim.verified`, `research/audit.finding`, `research/report.sealed` (names + payload types; emitting is the producing plugin's job) |

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` mounts nothing at all |
| `root` | `.research-rep` | store root, resolved against the harness working directory |
| `maxSnapshotBytes` | `20971520` (20 MiB) | per-snapshot byte cap |
| `maxEvidence` | `10000` | evidence registrations before sealing/pruning |
| `maxClaims` | `10000` | claim registrations |

Invalid values fail loud at mount.

## Store layout

```
.research-rep/
├── objects/<sha256>          immutable snapshot bytes (atomic write, never overwritten)
├── snapshots.jsonl           snapshot registrations (first registration wins per address)
├── evidence.jsonl            evidence registrations
├── evidence-checks.jsonl     evidence checks (latest line wins)
├── claims.jsonl              claim registrations (immutable)
├── verdicts.jsonl            verdicts + their checks (latest line wins)
├── audits.jsonl              append-only hash-chained audit events
└── records/<id>.rep.json     sealed REP records
```

Every journal is append-only. A corrupt journal line fails loud with file and line number instead of being skipped. Reads re-hash snapshot objects, so tampering is detected, not trusted.

## Permissions & data

- **Local first.** No network calls anywhere in this package. Nothing is uploaded.
- **No telemetry.** No hidden reporting, no analytics.
- **No credentials.** Nothing here reads or stores tokens; audit payloads are documented as must-not-contain-secrets and the store is workspace-local.
- **No PII handling by itself.** Capture is explicit: a plugin decides what bytes become a snapshot. Do not snapshot personal data unless your plugin's policy allows it.
- **No code execution.** No PDF/HTML/script is ever executed; the CLI only reads JSON.

## Security boundaries

- Snapshot `path` must be `objects/<hex>` — path traversal cannot be expressed in a valid record.
- Record ids are validated against a strict id pattern before any file name is built.
- Objects are written with `O_EXCL`-style temp + rename and are **never overwritten**: if the stored bytes no longer hash to their address, the store refuses (`SNAPSHOT_TAMPERED`) instead of "repairing" it.
- A sealed record is never overwritten (`RECORD_EXISTS`).
- Hashing a mismatched snapshot is a hard verification failure; there is no `--force`.

## Known limitations

- **Record-level quote verification needs textual snapshots.** A PDF snapshot is stored and re-hashed, but its text is not extracted here; quote re-location for PDFs requires `dsh-doc-anchor` to also capture the extracted text as a `text/plain` snapshot.
- **`verifyClaim` is conservative.** A missing number yields `insufficient` (it might be computed), not `disproven`; only an absent verbatim quote is `disproven`. Semantic support is `dsh-claim-check`'s job (W2).
- **No session-log event emission yet.** Event names/payloads are exported; emitting them requires a session seam and is left to the producing plugin.
- **Single-writer assumption.** The store serializes writes with an in-process lock; two processes writing the same root concurrently are not coordinated.
- **Schema shape vs invariants.** `validateRep` checks cross-references and invariants (and a defensive structural pre-pass); the JSON Schema is the authority on shape. CI checks both against the 20 golden fixtures.

## Evaluation

There are **no precision/recall numbers for this package** and it does not claim any: it is protocol infrastructure, not a detector. What is measured:

- **107 unit/integration tests** across 10 files (`pnpm test`), covering: canonical JSON determinism, SHA-256 vectors, claim evaluation (5 verdict paths), invariant validation, audit-chain tampering, manifest sealing, store durability, tamper detection, Cordis mount/dispose, the research-report bridge, and the CLI exit codes.
- **20 golden fixtures** (`test/fixtures/*.rep.json`), 3 valid + 17 single-cause invalid, regenerated deterministically by the real functions and gated for drift (`UPDATE_FIXTURES=1 pnpm test`).
- **JSON Schema agreement**: the published schema accepts every valid fixture and rejects the structural invalid ones; semantic fixtures are marked `either` and covered by `validateRep`.

Behavioral detectors (`dsh-cite-verify`, `dsh-claim-check`, `dsh-statcheck`) carry their own precision/recall numbers against `dsh-research-bench`.

## Development

```sh
pnpm install
pnpm run typecheck     # sources + tests (TypeScript strict, exactOptionalPropertyTypes)
pnpm test              # vitest
pnpm run build         # tsc → lib/
pnpm run verify:package
UPDATE_FIXTURES=1 pnpm test   # regenerate golden fixtures after an intentional change
```

## License

Apache-2.0. No third-party runtime code; dev dependencies are MIT/Apache-2.0 tooling.
