/**
 * OpenAI platform usage and cost reporting via the Organization Usage API.
 *
 * Queries `api.openai.com/v1/organization/usage/completions` and
 * `/v1/organization/costs` with an OpenAI Admin API key (`sk-admin-...`,
 * carrying the `api.usage.read` scope) and emits daily and total completion
 * token counts and USD spend, defaulting to month-to-date. A standard project
 * key used for completions cannot read usage, so an Admin key is required.
 *
 * @module
 */
import { z } from "npm:zod@4.3.6";

const GlobalArgsSchema = z.object({
  apiKey: z.string().describe(
    "OpenAI Admin API key (sk-admin-...) carrying the api.usage.read scope. Store it in a vault and pass via a CEL expression; a standard project key cannot read usage.",
  ),
});

const ArgsSchema = z.object({
  startDate: z.string().optional().describe(
    "Inclusive start date YYYY-MM-DD (UTC). Defaults to the first of the current month.",
  ),
  days: z.number().int().positive().optional().describe(
    "Alternative to startDate: look back this many days from now.",
  ),
});

const DailyUsageSchema = z.object({
  date: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  requests: z.number(),
});

const UsageOutputSchema = z.object({
  periodStart: z.string(),
  periodEnd: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  requests: z.number(),
  daily: z.array(DailyUsageSchema),
  fetchedAt: z.string(),
});

const CostsOutputSchema = z.object({
  periodStart: z.string(),
  periodEnd: z.string(),
  currency: z.string(),
  totalUsd: z.number(),
  daily: z.array(z.object({ date: z.string(), usd: z.number() })),
  fetchedAt: z.string(),
});

interface UsageBucket {
  start_time: number;
  results?: Array<Record<string, unknown>>;
}

/** Resolve the inclusive period start (unix seconds) from the method args. */
function startUnix(startDate?: string, days?: number): number {
  if (startDate) {
    return Math.floor(Date.parse(`${startDate}T00:00:00Z`) / 1000);
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

/** Fetch every page of a paginated Organization Usage/Cost endpoint. */
async function fetchAllBuckets(
  url: string,
  apiKey: string,
): Promise<UsageBucket[]> {
  const buckets: UsageBucket[] = [];
  let page: string | undefined;
  for (let i = 0; i < 100; i++) {
    const u = new URL(url);
    if (page) u.searchParams.set("page", page);
    const res = await fetch(u, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      throw new Error(
        `OpenAI Usage API error (${res.status}): ${await res.text()}`,
      );
    }
    const json = await res.json();
    for (const b of json.data ?? []) buckets.push(b as UsageBucket);
    if (json.has_more && json.next_page) page = json.next_page;
    else break;
  }
  return buckets;
}

/** Model definition for the `@dougschaefer/openai-usage` type. */
export const model = {
  type: "@dougschaefer/openai-usage",
  version: "2026.05.27.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "usage": {
      description: "Completion token usage totals and daily breakdown",
      schema: UsageOutputSchema,
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
  methods: {
    usage: {
      description:
        "Fetch OpenAI completion token usage (input/output tokens and request counts) by day for the period. Defaults to month-to-date. Requires an Admin key with the api.usage.read scope.",
      arguments: ArgsSchema,
      execute: async (args: z.infer<typeof ArgsSchema>, context: {
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
        const url =
          `https://api.openai.com/v1/organization/usage/completions?start_time=${start}&bucket_width=1d&limit=31`;
        const buckets = await fetchAllBuckets(url, context.globalArgs.apiKey);

        let inputTokens = 0, outputTokens = 0, requests = 0;
        const daily: z.infer<typeof DailyUsageSchema>[] = [];
        for (const b of buckets) {
          let bi = 0, bo = 0, br = 0;
          for (const r of b.results ?? []) {
            bi += Number(r.input_tokens ?? 0);
            bo += Number(r.output_tokens ?? 0);
            br += Number(r.num_model_requests ?? 0);
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
            });
          }
        }

        context.logger.info(
          "OpenAI usage since {start}: {in} in + {out} out = {total} tokens across {reqs} requests",
          {
            start: ymd(start),
            in: inputTokens,
            out: outputTokens,
            total: inputTokens + outputTokens,
            reqs: requests,
          },
        );
        const handle = await context.writeResource("usage", "usage", {
          periodStart: ymd(start),
          periodEnd: ymd(Math.floor(Date.now() / 1000)),
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens,
          requests,
          daily,
          fetchedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    costs: {
      description:
        "Fetch OpenAI spend in USD by day for the period. Defaults to month-to-date. Requires an Admin key with the api.usage.read scope.",
      arguments: ArgsSchema,
      execute: async (args: z.infer<typeof ArgsSchema>, context: {
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
        const url =
          `https://api.openai.com/v1/organization/costs?start_time=${start}&limit=180`;
        const buckets = await fetchAllBuckets(url, context.globalArgs.apiKey);

        let totalUsd = 0;
        let currency = "usd";
        const daily: { date: string; usd: number }[] = [];
        for (const b of buckets) {
          let d = 0;
          for (const r of b.results ?? []) {
            const amount = (r.amount ?? {}) as Record<string, unknown>;
            d += Number(amount.value ?? 0);
            if (amount.currency) currency = String(amount.currency);
          }
          totalUsd += d;
          if (d) {
            daily.push({ date: ymd(b.start_time), usd: Number(d.toFixed(4)) });
          }
        }

        context.logger.info("OpenAI spend since {start}: {total} {cur}", {
          start: ymd(start),
          total: totalUsd.toFixed(2),
          cur: currency,
        });
        const handle = await context.writeResource("costs", "costs", {
          periodStart: ymd(start),
          periodEnd: ymd(Math.floor(Date.now() / 1000)),
          currency,
          totalUsd: Number(totalUsd.toFixed(4)),
          daily,
          fetchedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
