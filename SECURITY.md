# Security policy

## Reporting a vulnerability

Open a **private security advisory** on this repository (Security → Advisories →
Report a vulnerability). It is visible to the maintainer only, and it keeps the
details out of a public issue.

Please include what you observed, how to reproduce it, and the affected versions.
A reply comes within 72 hours, and a fix is coordinated with you before it is
public.

Do not open a public issue for anything that could be exploited against a running
instance.

## In scope

Anything that reaches a service running this code, including:

- Authentication and authorization on `/v1`, including the API key handling, the
  admin key used by `/v1/keys` and `/v1/analytics`, and the loopback/local-access
  rules on which those depend.
- The `/v1/mcp` transports and their Host and Origin validation.
- Anything a remote caller can reach by request: `/v1/research`, `/v1/search`,
  `/v1/contents`, including the URL handling that fetches pages and follows
  redirects.
- SQLite state in the data directory, and what a malformed request can do to it.

## Out of scope

- Reports that require an authenticated key. A valid key is trusted input by
  design, and its holder already holds that key's privileges.
- Anything that requires control of the host, the data directory, or the network
  between Athena and its providers.
- Cosmetic issues that do not affect a running service.

## What a report is not

A missing feature, a hard limit the code documents deliberately, or an error
message that describes the failure accurately.
