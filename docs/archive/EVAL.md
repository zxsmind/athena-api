# Research evaluation plan

Evaluation is a release condition for research-quality claims. This file adapts Athena 001's evaluation ladder to the current 002 job engine and inline-citation output.

## Tier 0 — Deterministic contract checks

For every API job fixture, measure:

- every emitted citation index exists in that job's `sources` registry;
- every rendered citation link equals the URL at that source index;
- unregistered model-authored URLs/Markdown links do not survive finalization;
- the final response reports the resolved `budget_profile` and `reasoning_effort` independently;
- a search/contents-only request does not invoke the model layer;
- job event sequence IDs are monotonic and terminal events occur once.

These checks are not a semantic proof that a source passage entails a claim.

## Tier 1 — Retrieval diagnostics

Record result count, empty-result rate, duplicate URL rate, domain-filter yield, page extraction success, readable character yield, provider latency, and partial failures. Keep search and page-extraction metrics separate so a retrieval problem is distinguishable from an extraction problem.

## Tier 2 — Answer faithfulness

Grade alignment to the query, source support for factual claims, treatment of conflict/uncertainty, and citation placement. A citation that points to a real source but does not support its adjacent claim is a faithfulness failure.

## Tier 3 — Research comparisons

Compare budget profiles across a fixed held-out query set. Report quality, latency, provider requests, token usage, and monetary cost together. Do not advertise a profile as more accurate until the comparison has been run and preserved.

## Current state

The repository has focused tests for existing job lifecycle, research ledger, depth presets, settings, and Smart Routing. The newly added `/v1` API and citation finalizer still need dedicated contract coverage and a live provider run before making production-quality claims.
