# GitHub Action: `inference`

[![CI & Verification](https://github.com/govindarajanv/inference/actions/workflows/test.yml/badge.svg)](https://github.com/govindarajanv/inference/actions/workflows/test.yml)
[![Version](https://img.shields.io/badge/version-v1.0.0-blue.svg)](https://github.com/govindarajanv/inference/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

A resilient, zero-cost GitHub Action to execute AI inference within your workflows using the **free tier of [Kilo Gateway](https://kilo.ai/)**.

Designed for cross-repository usage (`uses: govindarajanv/inference@v1`), this action provides:
- **Zero Cost Guarantee**: Strictly enforces free-tier models (`enforce_free: true`), protecting public repositories against accidental billing.
- **Graceful Failure Handling**: Prevents workflow pipeline crashes when free limits are exhausted, rate limits trigger (HTTP 429), or model providers throttle requests.
- **Automatic Fallback Chain**: Tries alternative free models if the primary free model is at capacity or unavailable.
- **Exponential Backoff & Retries**: Automatically retries transient errors with randomized jitter.
- **Rich GitHub Step Summaries**: Produces detailed markdown summaries in the GitHub Actions UI showing token usage, selected model, and diagnostics.

---

## Quick Start

Call this action directly from any GitHub workflow in any repository:

```yaml
name: AI PR Summary
on:
  pull_request:
    types: [opened]

jobs:
  summarize:
    runs-on: ubuntu-latest
    steps:
      - name: Run Free AI Inference
        uses: govindarajanv/inference@v1
        id: ai
        with:
          prompt: "Provide a 2-bullet summary for PR: ${{ github.event.pull_request.title }}"
          model: 'kilo-auto/free'
          fail_on_error: 'false' # Won't crash your pipeline if free limits are exhausted

      - name: Use AI Response
        if: steps.ai.outputs.success == 'true'
        run: |
          echo "Generated summary: ${{ steps.ai.outputs.response }}"
```

---

## Free Tier & Limits

Kilo Gateway provides unauthenticated and authenticated access to free models:
- **Free Limit**: Free models are rate-limited to **200 requests/hour per IP address**.
- **Supported Free Models**:
  - `kilo-auto/free` *(recommended default: automatically routes to active free models)*
  - `deepseek/deepseek-v4-flash-0731:free`
  - `stepfun/step-3.7-flash:free`
  - `qwen/qwen3.8-27b:free`
  - `nvidia/nemotron-3-ultra-550b-a55b:free`
  - Any model ending with `:free` in the Kilo catalog.
- **Anonymous / Zero Secret Setup**: No API key is required for free models. However, an optional `api_key` can be supplied if you have your own Kilo account.

---

## Graceful Failure Handling

In CI/CD environments, secondary tasks (e.g. AI-generated commit summaries, changelogs, review suggestions) should not block mission-critical test and deployment pipelines if the AI provider is rate-limited or throttling.

By default (`fail_on_error: false`):
1. If the rate limit (200 req/hr) is reached, the model returns HTTP 429, or upstream servers return 5xx errors:
   - The action attempts retries with exponential backoff.
   - The action tries every model in `fallback_models`.
2. If all retries and fallback models fail:
   - The workflow step completes with **exit code 0** (graceful).
   - An informative GitHub workflow warning (`::warning::`) is emitted.
   - `success` output is set to `"false"`.
   - `status` output is set to `"rate_limited"` (or `"service_unavailable"` / `"timeout"`).
   - `error` output contains the exact diagnostics.
   - A step summary table is published explaining the exhaustion.
3. If you want the workflow step to strictly fail on error, set `fail_on_error: true`.

---

## Action Inputs

| Input | Description | Required | Default |
| :--- | :--- | :---: | :--- |
| `prompt` | Prompt text to send to the model. Either `prompt` or `messages` is required. | No | `''` |
| `system_prompt` | Optional system instructions / role prompt. | No | `''` |
| `messages` | Raw OpenAI-format messages JSON array (e.g. `[{"role":"user","content":"hello"}]`). | No | `''` |
| `model` | Target free model ID. | No | `'kilo-auto/free'` |
| `fallback_models` | Comma-separated or JSON list of fallback free models to try if the primary model fails or throttles. | No | `'kilo-auto/free,deepseek/deepseek-v4-flash-0731:free,stepfun/step-3.7-flash:free,qwen/qwen3.8-27b:free,nvidia/nemotron-3-ultra-550b-a55b:free'` |
| `api_key` | Optional Kilo API key (`${{ secrets.KILO_API_KEY }}`). | No | `''` |
| `gateway_url` | Base URL for Kilo Gateway API. | No | `'https://api.kilo.ai/api/gateway'` |
| `max_tokens` | Maximum tokens to generate. | No | `'1024'` |
| `temperature` | Sampling temperature (`0.0` to `2.0`). | No | `'0.7'` |
| `max_retries` | Maximum retries per candidate model on rate limit or server error. | No | `'3'` |
| `retry_delay_ms` | Initial backoff delay in milliseconds. | No | `'2000'` |
| `timeout_ms` | Request timeout in milliseconds. | No | `'60000'` |
| `enforce_free` | Strictly rejects non-free models to prevent accidental billing on public repos. | No | `'true'` |
| `fail_on_error` | If `false`, step passes gracefully on rate limit / throttling; if `true`, calls `core.setFailed`. | No | `'false'` |
| `save_to_file` | Optional path to write output directly to a file (e.g. `./summary.md`). | No | `''` |

---

## Action Outputs

| Output | Description |
| :--- | :--- |
| `response` | The completion text returned by the model. |
| `success` | `"true"` if inference succeeded, `"false"` otherwise. |
| `status` | Status code (`success`, `rate_limited`, `service_unavailable`, `timeout`, `no_valid_free_models`, `fatal_error`). |
| `error` | Diagnostic error message if failed, or empty string on success. |
| `model_used` | The exact model ID that produced the completion. |
| `total_tokens` | Total tokens consumed. |
| `prompt_tokens` | Prompt tokens consumed. |
| `completion_tokens`| Completion tokens generated. |
| `finish_reason` | Model finish reason (e.g. `stop`, `length`). |

---

## Usage Examples

### 1. System Prompt + User Prompt with File Output

```yaml
- name: Generate Release Notes
  uses: govindarajanv/inference@v1
  id: release_notes
  with:
    system_prompt: "You are a technical release manager. Create markdown bullet points from git commit history."
    prompt: ${{ steps.git_log.outputs.commits }}
    model: 'kilo-auto/free'
    save_to_file: './dist/RELEASE_NOTES.md'
    fail_on_error: 'false'
```

### 2. Full Messages Payload (Multi-Turn or Chat History)

```yaml
- name: Multi-Turn Conversation
  uses: govindarajanv/inference@v1
  id: chat
  with:
    messages: |
      [
        {"role": "system", "content": "You are a code reviewer."},
        {"role": "user", "content": "Review this function:\ndef add(a, b): return a + b"}
      ]
    max_tokens: 500
```

### 3. Graceful Pipeline Flow (Conditional Steps)

```yaml
- name: Run Inference
  uses: govindarajanv/inference@v1
  id: ai
  with:
    prompt: "Generate a greeting"
    fail_on_error: 'false'

- name: Post Comment if AI Succeeded
  if: steps.ai.outputs.success == 'true'
  run: |
    gh pr comment ${{ github.event.pull_request.number }} --body "${{ steps.ai.outputs.response }}"
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

- name: Log Status if Rate Limited
  if: steps.ai.outputs.success != 'true'
  run: |
    echo "AI inference skipped due to: ${{ steps.ai.outputs.status }} (${{ steps.ai.outputs.error }})"
```

---

## Semantic Versioning

This action follows [Semantic Versioning (SemVer)](https://semver.org/):
- `v1.0.0`: Initial stable release.
- Floating major tag `v1` is automatically maintained so workflows targeting `uses: govindarajanv/inference@v1` automatically receive non-breaking improvements.

---

## License

[MIT](LICENSE) © Govindarajan V
