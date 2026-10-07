# @dougschaefer/openai-usage

Report OpenAI **platform** usage and spend from the Organization Usage API,
straight from swamp. It queries the `api.openai.com/v1/organization/usage/*`
buckets (completions, embeddings, moderations, images, audio_speeches, and
audio_transcriptions) and `/v1/organization/costs`, paginates the daily buckets,
and emits totals plus a day-by-day breakdown, optionally grouped and filtered by
project, model, API key, or cost line item.

This targets the OpenAI platform (`platform.openai.com`), not Azure OpenAI,
Bedrock, or Vertex — for those, see `@webframp/ai-usage`.

## Prerequisite: an Admin key

OpenAI gates usage and cost behind the **`api.usage.read`** scope. A standard
project key (`sk-proj-...`) used for completions **cannot** read usage — it
returns `403 ... missing scopes: api.usage.read`. You need an **Admin key**
(`sk-admin-...`):

1. At `platform.openai.com`, open **Settings → Organization → Admin keys** and
   create one with the `api.usage.read` scope (read access to usage and costs).
2. Store it in a vault (kept local, never committed):
   ```bash
   swamp vault put openai admin-key
   ```
3. Create the model instance, referencing the secret by expression:
   ```bash
   swamp model create @dougschaefer/openai-usage openai-usage \
     --global-arg 'apiKey=${{ vault.get(openai, admin-key) }}'
   ```

## Methods

| Method        | What it returns                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| `usage`       | Completion token usage — input, output, and total tokens, plus request counts, totals and a daily breakdown.  |
| `usageByType` | Embeddings, moderations, images, or audio usage — a quantity in that type's unit plus request counts, by day. |
| `costs`       | Spend in USD — total and a daily breakdown.                                                                   |

All default to **month-to-date**. Pass `startDate` (`YYYY-MM-DD`) or `days`
(look-back window) to change the period. The period is capped at 2,900 days
(about 8 years, which keeps every request inside the 100-page limit): `days`
above 2,900, a `startDate` more than 2,900 days back or in the future (UTC), or
a `startDate` that is not a real calendar date is rejected with an error. If the
API ever paginates past 100 pages, or reports more data without a `next_page`
cursor, the method fails rather than storing a truncated total. A `429` is
retried once after its `Retry-After` (capped at 30 seconds); a second `429`
fails with a rate-limit error.

```bash
# Month-to-date token usage
swamp model method run openai-usage usage --json

# Spend over the last 7 days
swamp model method run openai-usage costs --input '{"days": 7}' --json

# Inspect the stored result
swamp data get openai-usage usage
swamp data get openai-usage costs
```

### Other usage types

`usage` covers completions only. `usageByType` reads the sibling Organization
Usage endpoints, selected by a required `type` argument. Each endpoint counts a
different unit, so the result stores a generic `quantity` (totals, per day, and
per group) together with `unit` and `type`, plus `requests` from
`num_model_requests`:

| `type`                 | Endpoint                     | `unit` (result field) |
| ---------------------- | ---------------------------- | --------------------- |
| `embeddings`           | `usage/embeddings`           | `input_tokens`        |
| `moderations`          | `usage/moderations`          | `input_tokens`        |
| `images`               | `usage/images`               | `images`              |
| `audio_speeches`       | `usage/audio_speeches`       | `characters`          |
| `audio_transcriptions` | `usage/audio_transcriptions` | `seconds`             |

It takes the same `startDate`/`days`, `groupBy`, `projectIds`, and `models`
arguments as `usage`. Each type is stored as its own `usageByType` data instance
named after the type, so the types keep separate histories.

```bash
# Month-to-date embedding tokens per model
swamp model method run openai-usage usageByType \
  --input '{"type": "embeddings", "groupBy": ["model"]}' --json
swamp data get openai-usage embeddings

# Images generated over the last 30 days
swamp model method run openai-usage usageByType \
  --input '{"type": "images", "days": 30}' --json
```

### Grouping and filtering

The `usage` and `costs` methods (and `usageByType`, with the same options as
`usage`) take an optional `groupBy` for per-project, per-model, or per-line-item
attribution. With no `groupBy` the output is exactly the org-wide totals and
daily breakdown described above.

| Method        | `groupBy` values                    | Filters                                            |
| ------------- | ----------------------------------- | -------------------------------------------------- |
| `usage`       | `project_id`, `model`, `api_key_id` | `projectIds` (project IDs), `models` (model names) |
| `usageByType` | `project_id`, `model`, `api_key_id` | `projectIds` (project IDs), `models` (model names) |
| `costs`       | `line_item`, `project_id`           | `projectIds` (project IDs)                         |

They are sent to the API as repeated query parameters (`group_by`,
`project_ids`, `models`). Filters work with or without grouping; filtered totals
cover only the matching projects or models.

When grouped, each `daily` entry gains a `groups` array holding that day's
per-group figures, and the result gains `groupBy` (echoing the request) and a
top-level `groups` array that rolls each group up over the whole period, largest
first. Group keys are stored camelCase — `projectId`, `model`, `apiKeyId`,
`lineItem` — and are `null` where the API did not attribute a result (for
example usage with no project).

```bash
# Month-to-date tokens per project and model
swamp model method run openai-usage usage \
  --input '{"groupBy": ["project_id", "model"]}' --json

# Last 30 days of spend for one project, by line item
swamp model method run openai-usage costs \
  --input '{"days": 30, "groupBy": ["line_item"], "projectIds": ["proj_example"]}' --json
```

Results are versioned swamp data, so downstream models, reports, and workflows
can reference them by CEL.

## Testing attestation

Verified in a production lab against a live OpenAI organization: `usage` and
`costs` return month-to-date token totals and USD spend with correct daily
buckets, and both fail with a clear, actionable error when handed a non-admin
key. That live verification predates the 2026-10-07 additions: `groupBy` and the
`projectIds`/`models` filters on `usage` and `costs`, like `usageByType`, are
covered by mocked unit tests only and have not yet been verified against a live
organization. The pagination, period-cap, and 429-retry guards are likewise
covered by mocked tests only.
