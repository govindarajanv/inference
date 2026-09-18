# Repository Context: inference

## Overview
This repository defines a reusable GitHub Action named **`inference`** (`govindarajanv/inference`) that enables any workflow across different repositories to run AI inference using Kilo Gateway's free tier.

## Semantic Versioning
- Brand-new repository starts at `v1.0.0`.
- Each iteration/functional change set increments following SemVer (`v[major].[minor].[patch]`).
- Tag releases with `v1.0.0` and maintain major version floating tags (e.g. `v1`).

## Core Principles & Constraints
1. **Free Gateway Only**:
   - Because this repository is public, paid models or paid tiers must never be required or accidentally triggered.
   - Enforce free tier models by default (`kilo-auto/free` or models suffixed with `:free`).
   - Validate model selections to prevent inadvertent charges.
   - Free gateway tier permits up to 200 requests/hour per IP (anonymous or authenticated).
2. **Resilience & Graceful Failure**:
   - Rate limit exhaustion (HTTP 429), model API throttling, timeout, or upstream outages must degrade gracefully.
   - Intelligent retries with exponential backoff on transient errors (429, 500, 502, 503, 504).
   - Automatic fallback to alternative free models (`kilo-auto/free`, `deepseek/deepseek-v4-flash-0731:free`, `stepfun/step-3.7-flash:free`, `qwen/qwen3.8-27b:free`, etc.) if primary model is throttled.
   - Graceful step exit: By default (`fail_on_error: false`), rate limits or throttling will not break or crash the calling pipeline. Structured outputs (`success=false`, `status=rate_limited`, `error=...`) and workflow notices/warnings are provided. Callers can optionally set `fail_on_error: true` if desired.
