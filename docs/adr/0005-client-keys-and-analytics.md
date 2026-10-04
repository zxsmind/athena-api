# ADR 0005 — Client keys and API analytics use the platform store

**Status:** Adopted for `/v1`.

## Decision

Client API secrets are generated once, returned once, and stored only as SHA-256 hashes in a local SQLite table. Request method, normalized route, status, latency, and optional key ID are recorded in a separate table. Conversations, research snapshots, and sequenced events also use this database. Key-management and aggregate analytics routes are loopback/private-network only; remote v1 calls require a Bearer key.

Provider credentials remain in the existing server settings file. The Settings API returns stable opaque slot markers so it can round-trip credential arrays without returning their values.

## Consequences

The app has a real client-key lifecycle and basic request analytics without exposing a stored client secret. Analytics currently do not calculate model token prices or enforce per-key quotas. Legacy unversioned endpoints remain compatibility routes for a trusted network.
