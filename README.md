# @dougschaefer/openai-usage

Report OpenAI **platform** token usage and spend from the Organization Usage
API, straight from swamp. It queries
`api.openai.com/v1/organization/usage/completions` and
`/v1/organization/costs`, paginates the daily buckets, and emits totals plus a
day-by-day breakdown.

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

| Method  | What it returns                                                                 |
| ------- | ------------------------------------------------------------------------------- |
| `usage` | Completion token usage — input, output, and total tokens, plus request counts, totals and a daily breakdown. |
| `costs` | Spend in USD — total and a daily breakdown.                                      |

Both default to **month-to-date**. Pass `startDate` (`YYYY-MM-DD`) or `days`
(look-back window) to change the period.

```bash
# Month-to-date token usage
swamp model method run openai-usage usage --json

# Spend over the last 7 days
swamp model method run openai-usage costs --input '{"days": 7}' --json

# Inspect the stored result
swamp data get openai-usage usage
swamp data get openai-usage costs
```

Results are versioned swamp data, so downstream models, reports, and workflows
can reference them by CEL.

## Testing attestation

Verified in a production lab against a live OpenAI organization: `usage` and `costs`
return month-to-date token totals and USD spend with correct daily buckets, and
both fail with a clear, actionable error when handed a non-admin key.
