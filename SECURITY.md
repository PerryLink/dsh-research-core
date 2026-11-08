# Security policy

## Supported versions

The latest published `0.1.x` release of this package receives security fixes.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting (Security → Advisories) on
the repository, or open a minimal issue asking for a private channel if
advisories are unavailable. Do not include credentials, personal data or
working exploits in a public issue.

## Scope notes

- This package performs local file analysis only unless its README documents a
  network provider; when it does, only the documented hosts are contacted.
- Inputs are treated as untrusted data: document text is never executed.
- No secrets are read or written by the package.
