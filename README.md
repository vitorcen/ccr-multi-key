# Claude Code Router (fork)

Forked from: https://github.com/musistudio/claude-code-router

This fork focuses on provider key rotation and per-key metrics/diagnostics:

- Multi-key rotation per provider (advance only on success)
- Per-key usage stats written back to the config file: req_count, req_tokens, rsp_tokens
- Per-key error recording: err_code, err_msg (e.g., 401/403)
- Global --config CLI option supported for all commands (start, code, ui, …)
- 4xx (non-429) failures won’t rotate key within the same request, allowing client/system retries to surface visibly in UI

## Installation

```
npm install -g @vitorcen/ccr-multi-key
```

## CLI

- Use a custom config file anywhere in command:
  `ccrm -c /path/to/config.json code "..."` 
  or `ccrm code --config=/path/to/config.json "..."`
- The router will write metrics back to that same file.

## Quick config example (no stats fields)

```json
{
  "Providers": [
    {
      "name": "gemini",
      "api_base_url": "https://generativelanguage.googleapis.com/v1beta/models/",
      "api_keys": [
        { "name": "free_tier1", "key": "sk-..." },
        { "name": "free_tier2", "key": "sk-..." },
        { "name": "free_tier3", "key": "sk-..." }
      ]
    }
  ],
  "Router": {
    "default": "gemini,gemini-2.5-pro"
  }
}
```

## Stats fields example (written back by the router)

```json
{
  "Providers": [
    {
      "name": "gemini",
      "api_keys": [
        {
          "name": "free_tier1",
          "key": "sk-...",
          "req_count": 3,
          "req_tokens": 74196,
          "rsp_tokens": 695,
          "err_code": 0,
          "err_msg": ""
        },
        {
          "name": "free_tier2",
          "key": "sk-...",
          "req_count": 2,
          "req_tokens": 1580,
          "rsp_tokens": 0,
          "err_code": 401,
          "err_msg": "Error from provider(,... 401): No auth credentials found"
        },
        {
          "name": "free_tier3",
          "key": "sk-...",
          "req_count": 1,
          "req_tokens": 980,
          "rsp_tokens": 120,
          "err_code": 0,
          "err_msg": ""
        }
      ]
    }
  ]
}
```

## Gemini API rate limits (official)

Important: Gemini rate limits are applied per project, not per API key. “Free tier x3” only aggregates if you use three separate projects (and thus three independent quotas). If all keys belong to the same project, quotas do NOT add up.

### Gemini 2.5 Pro (text-out) — Free vs Free x3 vs Tier 1


| Limit Type                | Free Tier | Free Tier ×3 |    Tier 1 |
| --------------------------- | ----------: | --------------: | ----------: |
| RPM (requests per minute) |         5 |            15 |       150 |
| TPM (tokens per minute)   |   250,000 |       750,000 | 2,000,000 |
| RPD (requests per day)    |       100 |           300 |    10,000 |

### Gemini 2.5 Flash (text-out) — Free vs Free x3 vs Tier 1


| Limit Type                | Free Tier | Free Tier ×3 |    Tier 1 |
| --------------------------- | ----------: | --------------: | ----------: |
| RPM (requests per minute) |        10 |            30 |     1,000 |
| TPM (tokens per minute)   |   250,000 |       750,000 | 1,000,000 |
| RPD (requests per day)    |       250 |           750 |    10,000 |

Notes:

### Notes on using multiple keys / rotation (Gemini)

- Limits are per project, not per API key. Rotating several keys of the same project will NOT increase effective RPM/TPM/RPD.
- Aggregating “Free ×3” only works if the keys belong to three separate projects (hence three independent quotas). Even then, Google states that rate limits are “not guaranteed and actual capacity may vary,”.
- Recommended path: upgrade your tier, request rate limit increases, or shard traffic across truly independent projects that meet Google’s policies.

  - Rate limits: https://ai.google.dev/gemini-api/docs/rate-limits
  - Additional usage policies: https://ai.google.dev/gemini-api/docs/usage-policies
- Free/Tier 1 numbers vary by model; tables above show the two most common text-out models.
- Some models have additional dimensions (e.g., sessions for Live API, image/minute for Imagen). See the official table for details.
- Use a custom config file anywhere in command: `ccr --config /path/to/config.json code "..."` or `ccr code --config=/path/to/config.json "..."`
- The router will write metrics back to that same file.
