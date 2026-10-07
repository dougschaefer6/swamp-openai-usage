/**
 * OpenAI platform usage and cost reporting via the Organization Usage API.
 *
 * Queries the `api.openai.com/v1/organization/usage/*` buckets (completions,
 * embeddings, moderations, images, audio_speeches, audio_transcriptions) and
 * `/v1/organization/costs` with an OpenAI Admin API key (`sk-admin-...`,
 * carrying the `api.usage.read` scope) and emits daily and total usage and USD
 * spend, defaulting to month-to-date. A standard project key used for
 * completions cannot read usage, so an Admin key is required.
 *
 * The period is capped at `MAX_DAYS`, and a result that the API paginates past
 * `MAX_PAGES`, or that claims more pages without a cursor, fails loudly rather
 * than storing a silently truncated total.
 *
 * Both methods take an optional `groupBy` (plus `projectIds`, and `models` for
 * usage) to attribute tokens and spend per project, model, API key, or cost
 * line item. With no grouping the output is unchanged.
 *
 * `usageByType` reads the sibling usage endpoints (embeddings, moderations,
 * images, audio_speeches, audio_transcriptions), which share the bucket shape
 * but each count a different unit, into one generic quantity/requests schema.
 *
 * @module
 */
import { z } from "npm:zod@4.3.6";

const GlobalArgsSchema = z.object({
  apiKey: z.string().meta({ sensitive: true }).describe(
    "OpenAI Admin API key (sk-admin-...) carrying the api.usage.read scope. Store it in a vault and pass via a CEL expression; a standard project key cannot read usage.",
  ),
});

/**
 * Longest period a method will request (~8 years). At the smallest page size
 * used (31 daily buckets for the usage endpoints) that is at most 94 pages,
 * inside `MAX_PAGES`, so a capped request can never hit the page limit while
 * multi-year pulls that worked before this cap keep working.
 */
export const MAX_DAYS = 2900;

/** Hard stop on pagination; exceeding it is an error, never a partial result. */
export const MAX_PAGES = 100;

/** Longest Retry-After wait honoured on a 429 before the single retry. */
export const MAX_RETRY_AFTER_MS = 30_000;

/** True when `s` is a YYYY-MM-DD string naming a real calendar date. */
function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  // Round-trip so rollovers such as 2026-02-30 are rejected, not shifted.
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

const ArgsSchema = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, {
    message: "startDate must be in YYYY-MM-DD form",
  }).refine(isRealDate, {
    message: "startDate must be a real calendar date in YYYY-MM-DD form",
  }).optional().describe(
    `Inclusive start date YYYY-MM-DD (UTC), at most ${MAX_DAYS} days ago. Defaults to the first of the current month.`,
  ),
  days: z.number().int().positive().max(MAX_DAYS, {
    message: `days must be at most ${MAX_DAYS}`,
  }).optional().describe(
    `Alternative to startDate: look back this many days from now (at most ${MAX_DAYS}).`,
  ),
});

const UsageArgsSchema = ArgsSchema.extend({
  groupBy: z.array(z.enum(["project_id", "model", "api_key_id"])).optional()
    .describe(
      "Group usage by any of project_id, model, api_key_id. Omit for org-wide totals only.",
    ),
  projectIds: z.array(z.string()).optional().describe(
    "Only include usage for these project IDs.",
  ),
  models: z.array(z.string()).optional().describe(
    "Only include usage for these models (e.g. gpt-4o-mini).",
  ),
});

/**
 * Non-completions usage endpoints and the result field each one counts. The
 * unit is stored alongside the quantity so consumers know what it measures.
 */
export const USAGE_TYPES = {
  embeddings: { field: "input_tokens", unit: "input_tokens" },
  moderations: { field: "input_tokens", unit: "input_tokens" },
  images: { field: "images", unit: "images" },
  audio_speeches: { field: "characters", unit: "characters" },
  audio_transcriptions: { field: "seconds", unit: "seconds" },
} as const;

type UsageType = keyof typeof USAGE_TYPES;

const UsageByTypeArgsSchema = UsageArgsSchema.extend({
  type: z.enum(Object.keys(USAGE_TYPES) as [UsageType, ...UsageType[]])
    .describe(
      "Usage endpoint to read: embeddings, moderations, images, audio_speeches, or audio_transcriptions.",
    ),
});

const CostsArgsSchema = ArgsSchema.extend({
  groupBy: z.array(z.enum(["line_item", "project_id"])).optional().describe(
    "Group spend by any of line_item, project_id. Omit for org-wide totals only.",
  ),
  projectIds: z.array(z.string()).optional().describe(
    "Only include spend for these project IDs.",
  ),
});

/** Group keys from a bucket result; null means the API left it unattributed. */
const GroupKeysSchema = z.object({
  projectId: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  apiKeyId: z.string().nullable().optional(),
  lineItem: z.string().nullable().optional(),
});

const UsageTotalsSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  requests: z.number(),
});

const UsageGroupSchema = GroupKeysSchema.extend(UsageTotalsSchema.shape);

const DailyUsageSchema = UsageTotalsSchema.extend({
  date: z.string(),
  groups: z.array(UsageGroupSchema).optional(),
});

const UsageOutputSchema = z.object({
  periodStart: z.string(),
  periodEnd: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  requests: z.number(),
  daily: z.array(DailyUsageSchema),
  groupBy: z.array(z.string()).optional(),
  groups: z.array(UsageGroupSchema).optional(),
  fetchedAt: z.string(),
});

const TypedTotalsSchema = z.object({
  quantity: z.number(),
  requests: z.number(),
});

const TypedGroupSchema = GroupKeysSchema.extend(TypedTotalsSchema.shape);

const DailyTypedSchema = TypedTotalsSchema.extend({
  date: z.string(),
  groups: z.array(TypedGroupSchema).optional(),
});

const UsageByTypeOutputSchema = z.object({
  type: z.string(),
  unit: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  quantity: z.number(),
  requests: z.number(),
  daily: z.array(DailyTypedSchema),
  groupBy: z.array(z.string()).optional(),
  groups: z.array(TypedGroupSchema).optional(),
  fetchedAt: z.string(),
});

const CostGroupSchema = GroupKeysSchema.extend({ usd: z.number() });

const DailyCostSchema = z.object({
  date: z.string(),
  usd: z.number(),
  groups: z.array(CostGroupSchema).optional(),
});

const CostsOutputSchema = z.object({
  periodStart: z.string(),
  periodEnd: z.string(),
  currency: z.string(),
  totalUsd: z.number(),
  daily: z.array(DailyCostSchema),
  groupBy: z.array(z.string()).optional(),
  groups: z.array(CostGroupSchema).optional(),
  fetchedAt: z.string(),
});

type GroupKeys = z.infer<typeof GroupKeysSchema>;
type UsageGroup = z.infer<typeof UsageGroupSchema>;
type CostGroup = z.infer<typeof CostGroupSchema>;
type TypedGroup = z.infer<typeof TypedGroupSchema>;

interface UsageBucket {
  start_time: number;
  results?: Array<Record<string, unknown>>;
}

/** API group_by field name to the camelCase key stored in results. */
const GROUP_KEY_FIELDS: Record<string, keyof GroupKeys> = {
  project_id: "projectId",
  model: "model",
  api_key_id: "apiKeyId",
  line_item: "lineItem",
};

/**
 * Resolve the inclusive period start (unix seconds) from the method args.
 * The schema already rejects malformed dates and oversized `days`; this also
 * rejects a `startDate` in the future or more than `MAX_DAYS` back.
 */
function startUnix(startDate?: string, days?: number): number {
  if (startDate) {
    if (!isRealDate(startDate)) {
      throw new Error(
        `startDate "${startDate}" must be a real calendar date in YYYY-MM-DD form`,
      );
    }
    const start = Date.parse(`${startDate}T00:00:00Z`);
    const now = new Date();
    const today = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    if (start > today) {
      throw new Error(
        `startDate ${startDate} is in the future (dates are UTC)`,
      );
    }
    if ((today - start) / 86_400_000 > MAX_DAYS) {
      throw new Error(
        `startDate ${startDate} is more than ${MAX_DAYS} days ago, beyond what one run can fetch inside the API's ${MAX_PAGES}-page limit`,
      );
    }
    return Math.floor(start / 1000);
  }
  if (days) return Math.floor((Date.now() - days * 86_400_000) / 1000);
  const now = new Date();
  return Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000,
  );
}

/** Format a unix-seconds timestamp as a UTC YYYY-MM-DD date. */
function ymd(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

/** Round to 4 decimal places, as USD amounts are stored. */
function round4(n: number): number {
  return Number(n.toFixed(4));
}

/**
 * Build an Organization Usage/Cost endpoint URL. Array params are repeated
 * (`group_by=a&group_by=b`), which is how the API expects them; undefined
 * params are dropped.
 */
export function buildUrl(
  path: string,
  params: Record<string, string | number | string[] | undefined>,
): string {
  const u = new URL(`https://api.openai.com/v1/organization/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      for (const item of v) u.searchParams.append(k, item);
    } else {
      u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

/** Extract the requested group keys from one bucket result. */
function groupKeys(r: Record<string, unknown>, groupBy: string[]): GroupKeys {
  const keys: GroupKeys = {};
  for (const g of groupBy) {
    const v = r[g];
    keys[GROUP_KEY_FIELDS[g]] = v === null || v === undefined
      ? null
      : String(v);
  }
  return keys;
}

/**
 * Milliseconds to wait for a Retry-After header (delta-seconds or HTTP date),
 * capped at `MAX_RETRY_AFTER_MS`. A missing or unparseable header waits 1s.
 */
export function retryAfterMs(header: string | null): number {
  let ms = 1_000;
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs)) ms = secs * 1000;
    else {
      const at = Date.parse(header);
      if (!Number.isNaN(at)) ms = at - Date.now();
    }
  }
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

/** GET one page, retrying a single 429 after its (capped) Retry-After. */
async function fetchPage(u: URL, apiKey: string, path: string) {
  const init = { headers: { Authorization: `Bearer ${apiKey}` } };
  let res = await fetch(u, init);
  if (res.status === 429) {
    const wait = retryAfterMs(res.headers.get("retry-after"));
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, wait));
    res = await fetch(u, init);
    if (res.status === 429) {
      throw new Error(
        `OpenAI Usage API rate limit (429) on ${path} persisted after one retry (waited ${wait}ms): ${await res
          .text()}`,
      );
    }
  }
  if (!res.ok) {
    throw new Error(
      `OpenAI Usage API error (${res.status}): ${await res.text()}`,
    );
  }
  return await res.json();
}

/**
 * Fetch every page of a paginated Organization Usage/Cost endpoint. Throws,
 * rather than returning partial data, when the API still reports more pages
 * after `MAX_PAGES` or reports `has_more` without a `next_page` cursor.
 */
async function fetchAllBuckets(
  url: string,
  apiKey: string,
): Promise<UsageBucket[]> {
  const path = new URL(url).pathname;
  const buckets: UsageBucket[] = [];
  const progress = () => {
    const last = buckets[buckets.length - 1];
    return `${buckets.length} bucket(s)${
      last ? ` through ${ymd(last.start_time)}` : ""
    }`;
  };
  let page: string | undefined;
  for (let i = 1; i <= MAX_PAGES; i++) {
    const u = new URL(url);
    if (page) u.searchParams.set("page", page);
    const json = await fetchPage(u, apiKey, path);
    for (const b of json.data ?? []) buckets.push(b as UsageBucket);
    if (!json.has_more) return buckets;
    if (!json.next_page) {
      throw new Error(
        `OpenAI Usage API ${path} reported has_more without a next_page cursor after ${i} page(s) and ${progress()}; refusing to store a truncated result`,
      );
    }
    page = json.next_page;
  }
  throw new Error(
    `OpenAI Usage API ${path} still had more data after ${MAX_PAGES} pages and ${progress()}; refusing to store a truncated result. Shorten the period.`,
  );
}

/**
 * Sum usage buckets into period totals and a daily breakdown. When `groupBy`
 * is set, each day keeps its per-group results and `groups` holds the
 * per-group period rollup, largest token count first.
 */
export function summarizeUsage(buckets: UsageBucket[], groupBy?: string[]) {
  let inputTokens = 0, outputTokens = 0, requests = 0;
  const daily: z.infer<typeof DailyUsageSchema>[] = [];
  const rollup = new Map<string, UsageGroup>();
  for (const b of buckets) {
    let bi = 0, bo = 0, br = 0;
    const dayGroups: UsageGroup[] = [];
    for (const r of b.results ?? []) {
      const ri = Number(r.input_tokens ?? 0);
      const ro = Number(r.output_tokens ?? 0);
      const rr = Number(r.num_model_requests ?? 0);
      bi += ri;
      bo += ro;
      br += rr;
      if (!groupBy || !(ri || ro || rr)) continue;
      const keys = groupKeys(r, groupBy);
      dayGroups.push({
        ...keys,
        inputTokens: ri,
        outputTokens: ro,
        totalTokens: ri + ro,
        requests: rr,
      });
      const id = JSON.stringify(keys);
      const g = rollup.get(id) ??
        {
          ...keys,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          requests: 0,
        };
      g.inputTokens += ri;
      g.outputTokens += ro;
      g.totalTokens += ri + ro;
      g.requests += rr;
      rollup.set(id, g);
    }
    inputTokens += bi;
    outputTokens += bo;
    requests += br;
    if (bi || bo || br) {
      daily.push({
        date: ymd(b.start_time),
        inputTokens: bi,
        outputTokens: bo,
        totalTokens: bi + bo,
        requests: br,
        ...(groupBy ? { groups: dayGroups } : {}),
      });
    }
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    requests,
    daily,
    ...(groupBy
      ? {
        groupBy,
        groups: [...rollup.values()].sort((a, b) =>
          b.totalTokens - a.totalTokens
        ),
      }
      : {}),
  };
}

/**
 * Sum buckets from one of the non-completions usage endpoints into a generic
 * quantity (in the type's unit) and request count, with the same daily and
 * grouping behaviour as `summarizeUsage`.
 */
export function summarizeUsageByType(
  buckets: UsageBucket[],
  type: UsageType,
  groupBy?: string[],
) {
  const { field, unit } = USAGE_TYPES[type];
  let quantity = 0, requests = 0;
  const daily: z.infer<typeof DailyTypedSchema>[] = [];
  const rollup = new Map<string, TypedGroup>();
  for (const b of buckets) {
    let bq = 0, br = 0;
    const dayGroups: TypedGroup[] = [];
    for (const r of b.results ?? []) {
      const rq = Number(r[field] ?? 0);
      const rr = Number(r.num_model_requests ?? 0);
      bq += rq;
      br += rr;
      if (!groupBy || !(rq || rr)) continue;
      const keys = groupKeys(r, groupBy);
      dayGroups.push({ ...keys, quantity: rq, requests: rr });
      const id = JSON.stringify(keys);
      const g = rollup.get(id) ?? { ...keys, quantity: 0, requests: 0 };
      g.quantity += rq;
      g.requests += rr;
      rollup.set(id, g);
    }
    quantity += bq;
    requests += br;
    if (bq || br) {
      daily.push({
        date: ymd(b.start_time),
        quantity: bq,
        requests: br,
        ...(groupBy ? { groups: dayGroups } : {}),
      });
    }
  }
  return {
    type,
    unit,
    quantity,
    requests,
    daily,
    ...(groupBy
      ? {
        groupBy,
        groups: [...rollup.values()].sort((a, b) => b.quantity - a.quantity),
      }
      : {}),
  };
}

/**
 * Sum cost buckets into a USD total and a daily breakdown. When `groupBy` is
 * set, each day keeps its per-group amounts and `groups` holds the per-group
 * period rollup, largest spend first.
 */
export function summarizeCosts(buckets: UsageBucket[], groupBy?: string[]) {
  let totalUsd = 0;
  let currency = "usd";
  const daily: z.infer<typeof DailyCostSchema>[] = [];
  const rollup = new Map<string, CostGroup>();
  for (const b of buckets) {
    let d = 0;
    const dayGroups: CostGroup[] = [];
    for (const r of b.results ?? []) {
      const amount = (r.amount ?? {}) as Record<string, unknown>;
      const v = Number(amount.value ?? 0);
      d += v;
      if (amount.currency) currency = String(amount.currency);
      if (!groupBy || !v) continue;
      const keys = groupKeys(r, groupBy);
      dayGroups.push({ ...keys, usd: round4(v) });
      const id = JSON.stringify(keys);
      const g = rollup.get(id) ?? { ...keys, usd: 0 };
      g.usd += v;
      rollup.set(id, g);
    }
    totalUsd += d;
    if (d) {
      daily.push({
        date: ymd(b.start_time),
        usd: round4(d),
        ...(groupBy ? { groups: dayGroups } : {}),
      });
    }
  }
  return {
    currency,
    totalUsd: round4(totalUsd),
    daily,
    ...(groupBy
      ? {
        groupBy,
        groups: [...rollup.values()]
          .map((g) => ({ ...g, usd: round4(g.usd) }))
          .sort((a, b) => b.usd - a.usd),
      }
      : {}),
  };
}

/** Model definition for the `@dougschaefer/openai-usage` type. */
export const model = {
  type: "@dougschaefer/openai-usage",
  version: "2026.10.07.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    "usage": {
      description: "Completion token usage totals and daily breakdown",
      schema: UsageOutputSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
    "usageByType": {
      description:
        "Embeddings, moderations, images, or audio usage totals and daily breakdown, one instance per type",
      schema: UsageByTypeOutputSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
    "costs": {
      description: "Spend totals and daily breakdown in USD",
      schema: CostsOutputSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
  },
  // globalArguments are unchanged across versions, so the upgrade is a no-op;
  // swamp still needs the chain so existing instances are not stranded.
  upgrades: [
    {
      toVersion: "2026.10.07.1",
      description:
        "Add groupBy and project/model filters to usage and costs; globalArguments unchanged",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.07.2",
      description:
        "Add usageByType for embeddings, moderations, images, and audio usage; globalArguments unchanged",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  methods: {
    usage: {
      description:
        "Fetch OpenAI completion token usage (input/output tokens and request counts) by day for the period, optionally grouped by project, model, or API key and filtered to projects or models. Defaults to month-to-date. Requires an Admin key with the api.usage.read scope.",
      arguments: UsageArgsSchema,
      execute: async (args: z.infer<typeof UsageArgsSchema>, context: {
        globalArgs: z.infer<typeof GlobalArgsSchema>;
        logger: {
          info: (msg: string, props?: Record<string, unknown>) => void;
        };
        writeResource: (
          spec: string,
          name: string,
          data: unknown,
        ) => Promise<unknown>;
      }) => {
        const start = startUnix(args.startDate, args.days);
        const groupBy = args.groupBy?.length ? args.groupBy : undefined;
        context.logger.info(
          "Fetching OpenAI usage/completions from {start}, groupBy {groupBy}",
          { start: ymd(start), groupBy: groupBy?.join(",") ?? "none" },
        );
        const url = buildUrl("usage/completions", {
          start_time: start,
          bucket_width: "1d",
          limit: 31,
          group_by: groupBy,
          project_ids: args.projectIds,
          models: args.models,
        });
        const buckets = await fetchAllBuckets(url, context.globalArgs.apiKey);
        const summary = summarizeUsage(buckets, groupBy);

        context.logger.info(
          "OpenAI usage since {start}: {in} in + {out} out = {total} tokens across {reqs} requests",
          {
            start: ymd(start),
            in: summary.inputTokens,
            out: summary.outputTokens,
            total: summary.totalTokens,
            reqs: summary.requests,
          },
        );
        const handle = await context.writeResource("usage", "usage", {
          periodStart: ymd(start),
          periodEnd: ymd(Math.floor(Date.now() / 1000)),
          ...summary,
          fetchedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    usageByType: {
      description:
        "Fetch OpenAI usage for one non-completions endpoint (embeddings, moderations, images, audio_speeches, audio_transcriptions) by day for the period, as a quantity in that type's unit (input tokens, images, characters, or seconds) plus request counts. Optionally grouped by project, model, or API key and filtered to projects or models. Defaults to month-to-date. Requires an Admin key with the api.usage.read scope.",
      arguments: UsageByTypeArgsSchema,
      execute: async (args: z.infer<typeof UsageByTypeArgsSchema>, context: {
        globalArgs: z.infer<typeof GlobalArgsSchema>;
        logger: {
          info: (msg: string, props?: Record<string, unknown>) => void;
        };
        writeResource: (
          spec: string,
          name: string,
          data: unknown,
        ) => Promise<unknown>;
      }) => {
        const start = startUnix(args.startDate, args.days);
        const groupBy = args.groupBy?.length ? args.groupBy : undefined;
        context.logger.info(
          "Fetching OpenAI usage/{type} from {start}, groupBy {groupBy}",
          {
            type: args.type,
            start: ymd(start),
            groupBy: groupBy?.join(",") ?? "none",
          },
        );
        const url = buildUrl(`usage/${args.type}`, {
          start_time: start,
          bucket_width: "1d",
          limit: 31,
          group_by: groupBy,
          project_ids: args.projectIds,
          models: args.models,
        });
        const buckets = await fetchAllBuckets(url, context.globalArgs.apiKey);
        const summary = summarizeUsageByType(buckets, args.type, groupBy);

        context.logger.info(
          "OpenAI {type} usage since {start}: {qty} {unit} across {reqs} requests",
          {
            type: args.type,
            start: ymd(start),
            qty: summary.quantity,
            unit: summary.unit,
            reqs: summary.requests,
          },
        );
        // One instance per type, so each endpoint keeps its own history.
        const handle = await context.writeResource("usageByType", args.type, {
          periodStart: ymd(start),
          periodEnd: ymd(Math.floor(Date.now() / 1000)),
          ...summary,
          fetchedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    costs: {
      description:
        "Fetch OpenAI spend in USD by day for the period, optionally grouped by line item or project and filtered to projects. Defaults to month-to-date. Requires an Admin key with the api.usage.read scope.",
      arguments: CostsArgsSchema,
      execute: async (args: z.infer<typeof CostsArgsSchema>, context: {
        globalArgs: z.infer<typeof GlobalArgsSchema>;
        logger: {
          info: (msg: string, props?: Record<string, unknown>) => void;
        };
        writeResource: (
          spec: string,
          name: string,
          data: unknown,
        ) => Promise<unknown>;
      }) => {
        const start = startUnix(args.startDate, args.days);
        const groupBy = args.groupBy?.length ? args.groupBy : undefined;
        context.logger.info(
          "Fetching OpenAI costs from {start}, groupBy {groupBy}",
          { start: ymd(start), groupBy: groupBy?.join(",") ?? "none" },
        );
        const url = buildUrl("costs", {
          start_time: start,
          limit: 180,
          group_by: groupBy,
          project_ids: args.projectIds,
        });
        const buckets = await fetchAllBuckets(url, context.globalArgs.apiKey);
        const summary = summarizeCosts(buckets, groupBy);

        context.logger.info("OpenAI spend since {start}: {total} {cur}", {
          start: ymd(start),
          total: summary.totalUsd.toFixed(2),
          cur: summary.currency,
        });
        const handle = await context.writeResource("costs", "costs", {
          periodStart: ymd(start),
          periodEnd: ymd(Math.floor(Date.now() / 1000)),
          ...summary,
          fetchedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
