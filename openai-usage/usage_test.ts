import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { FakeTime } from "jsr:@std/testing@1/time";
import {
  buildUrl,
  MAX_DAYS,
  MAX_PAGES,
  model,
  retryAfterMs,
  summarizeCosts,
  summarizeUsage,
  summarizeUsageByType,
} from "./usage.ts";

// 2026-10-01 and 2026-10-02 00:00:00 UTC.
const DAY1 = 1790812800;
const DAY2 = DAY1 + 86_400;
/** Pinned "now" for tests that pass a fixed startDate: 2026-10-07 12:00 UTC. */
const NOW = Date.UTC(2026, 9, 7, 12);

/** Swap `globalThis.fetch` for a stub serving `pages` in order; returns a restore function. */
function mockFetch(
  urls: string[],
  pages: unknown[],
  status = 200,
): () => void {
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = ((input: string | URL | Request) => {
    urls.push(typeof input === "string" ? input : input.toString());
    const body = JSON.stringify(pages[Math.min(i++, pages.length - 1)]);
    return Promise.resolve(new Response(body, { status }));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** Swap `globalThis.fetch` for a stub returning `responses` in order. */
function mockResponses(urls: string[], responses: Response[]): () => void {
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = ((input: string | URL | Request) => {
    urls.push(typeof input === "string" ? input : input.toString());
    return Promise.resolve(responses[Math.min(i++, responses.length - 1)]);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** A fake method context that records `writeResource` and log calls. */
function fakeContext() {
  const writes: Array<
    { spec: string; name: string; data: Record<string, unknown> }
  > = [];
  const logs: Array<{ msg: string; props?: Record<string, unknown> }> = [];
  const ctx = {
    globalArgs: { apiKey: "test-key" },
    logger: {
      info: (msg: string, props?: Record<string, unknown>) => {
        logs.push({ msg, props });
      },
    },
    writeResource: (
      spec: string,
      name: string,
      data: unknown,
    ) => {
      writes.push({ spec, name, data: data as Record<string, unknown> });
      return Promise.resolve({ name, specName: spec });
    },
  };
  return { ctx, writes, logs };
}

// deno-lint-ignore no-explicit-any
const methods = model.methods as Record<string, any>;

function parseArgs(method: string, input: Record<string, unknown>) {
  return methods[method].arguments.parse(input);
}

function query(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

Deno.test("model version and upgrade chain run 2026.10.07.1 then .2", () => {
  assertEquals(model.version, "2026.10.07.2");
  assertEquals(
    model.upgrades.map((u) => u.toVersion),
    ["2026.10.07.1", "2026.10.07.2"],
  );
  const old = { apiKey: "test-key" };
  for (const u of model.upgrades) assertEquals(u.upgradeAttributes(old), old);
});

Deno.test("buildUrl repeats array params and drops undefined", () => {
  const url = buildUrl("usage/completions", {
    start_time: 1,
    group_by: ["project_id", "model"],
    models: undefined,
  });
  const q = query(url);
  assertEquals(q.getAll("group_by"), ["project_id", "model"]);
  assertEquals(q.get("start_time"), "1");
  assertEquals(q.has("models"), false);
});

Deno.test("argument schemas accept only documented group_by values", () => {
  parseArgs("usage", { groupBy: ["project_id", "model", "api_key_id"] });
  parseArgs("costs", { groupBy: ["line_item", "project_id"] });
  let threw = false;
  try {
    parseArgs("costs", { groupBy: ["model"] });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("summarizeUsage without groupBy keeps the original shape", () => {
  const s = summarizeUsage([
    {
      start_time: DAY1,
      results: [{ input_tokens: 10, output_tokens: 5, num_model_requests: 2 }],
    },
    { start_time: DAY2, results: [] },
  ]);
  assertEquals(s, {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    requests: 2,
    daily: [{
      date: "2026-10-01",
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      requests: 2,
    }],
  });
});

Deno.test("summarizeUsage groups per day and rolls up per group", () => {
  const s = summarizeUsage([
    {
      start_time: DAY1,
      results: [
        {
          project_id: "proj_a",
          model: "gpt-4o-mini",
          input_tokens: 100,
          output_tokens: 50,
          num_model_requests: 3,
        },
        {
          project_id: null,
          model: "gpt-4o",
          input_tokens: 10,
          output_tokens: 0,
          num_model_requests: 1,
        },
      ],
    },
    {
      start_time: DAY2,
      results: [{
        project_id: "proj_a",
        model: "gpt-4o-mini",
        input_tokens: 20,
        output_tokens: 10,
        num_model_requests: 1,
      }],
    },
  ], ["project_id", "model"]);

  assertEquals(s.totalTokens, 190);
  assertEquals(s.groupBy, ["project_id", "model"]);
  assertEquals(s.daily[0].groups?.length, 2);
  assertEquals(s.daily[0].groups?.[1], {
    projectId: null,
    model: "gpt-4o",
    inputTokens: 10,
    outputTokens: 0,
    totalTokens: 10,
    requests: 1,
  });
  assertEquals(s.groups, [
    {
      projectId: "proj_a",
      model: "gpt-4o-mini",
      inputTokens: 120,
      outputTokens: 60,
      totalTokens: 180,
      requests: 4,
    },
    {
      projectId: null,
      model: "gpt-4o",
      inputTokens: 10,
      outputTokens: 0,
      totalTokens: 10,
      requests: 1,
    },
  ]);
});

Deno.test("summarizeCosts groups by line item and project", () => {
  const s = summarizeCosts([
    {
      start_time: DAY1,
      results: [
        {
          line_item: "gpt-4o, input",
          project_id: "proj_a",
          amount: { value: 1.25, currency: "usd" },
        },
        {
          line_item: "gpt-4o, output",
          project_id: "proj_a",
          amount: { value: 2.5, currency: "usd" },
        },
      ],
    },
    {
      start_time: DAY2,
      results: [{
        line_item: "gpt-4o, input",
        project_id: "proj_a",
        amount: { value: 0.75, currency: "usd" },
      }],
    },
  ], ["line_item", "project_id"]);

  assertEquals(s.totalUsd, 4.5);
  assertEquals(s.daily[0].groups?.length, 2);
  assertEquals(s.groups, [
    { lineItem: "gpt-4o, output", projectId: "proj_a", usd: 2.5 },
    { lineItem: "gpt-4o, input", projectId: "proj_a", usd: 2 },
  ]);
});

Deno.test("summarizeCosts without groupBy omits group fields", () => {
  const s = summarizeCosts([{
    start_time: DAY1,
    results: [{ amount: { value: 3, currency: "usd" } }],
  }]);
  assertEquals(s, {
    currency: "usd",
    totalUsd: 3,
    daily: [{ date: "2026-10-01", usd: 3 }],
  });
});

Deno.test("usage method sends group_by, project_ids, models and paginates", async () => {
  const urls: string[] = [];
  const time = new FakeTime(NOW);
  const restore = mockFetch(urls, [
    {
      data: [{
        start_time: DAY1,
        results: [{
          project_id: "proj_a",
          input_tokens: 5,
          output_tokens: 5,
          num_model_requests: 1,
        }],
      }],
      has_more: true,
      next_page: "page_2",
    },
    { data: [], has_more: false },
  ]);
  try {
    const { ctx, writes } = fakeContext();
    await methods.usage.execute(
      parseArgs("usage", {
        startDate: "2026-10-01",
        groupBy: ["project_id"],
        projectIds: ["proj_a", "proj_b"],
        models: ["gpt-4o-mini"],
      }),
      ctx,
    );
    assertEquals(urls.length, 2);
    const q = query(urls[0]);
    assertEquals(
      new URL(urls[0]).pathname,
      "/v1/organization/usage/completions",
    );
    assertEquals(q.get("start_time"), String(DAY1));
    assertEquals(q.get("bucket_width"), "1d");
    assertEquals(q.getAll("group_by"), ["project_id"]);
    assertEquals(q.getAll("project_ids"), ["proj_a", "proj_b"]);
    assertEquals(q.getAll("models"), ["gpt-4o-mini"]);
    assertEquals(query(urls[1]).get("page"), "page_2");

    assertEquals(writes[0].spec, "usage");
    const data = writes[0].data;
    assertEquals(data.totalTokens, 10);
    assertEquals(data.groups, [{
      projectId: "proj_a",
      inputTokens: 5,
      outputTokens: 5,
      totalTokens: 10,
      requests: 1,
    }]);
  } finally {
    restore();
    time.restore();
  }
});

Deno.test("usage method without grouping sends no group params", async () => {
  const urls: string[] = [];
  const restore = mockFetch(urls, [{ data: [], has_more: false }]);
  try {
    const { ctx, writes } = fakeContext();
    await methods.usage.execute(parseArgs("usage", { days: 7 }), ctx);
    const q = query(urls[0]);
    assertEquals(q.has("group_by"), false);
    assertEquals(q.has("project_ids"), false);
    assertEquals(q.has("models"), false);
    assertEquals("groups" in writes[0].data, false);
    assertEquals("groupBy" in writes[0].data, false);
  } finally {
    restore();
  }
});

Deno.test("costs method sends group_by and project_ids", async () => {
  const urls: string[] = [];
  const restore = mockFetch(urls, [{
    data: [{
      start_time: DAY1,
      results: [{
        line_item: "gpt-4o, input",
        project_id: null,
        amount: { value: 1, currency: "usd" },
      }],
    }],
    has_more: false,
  }]);
  try {
    const { ctx, writes } = fakeContext();
    await methods.costs.execute(
      parseArgs("costs", {
        groupBy: ["line_item", "project_id"],
        projectIds: ["proj_a"],
      }),
      ctx,
    );
    const q = query(urls[0]);
    assertEquals(new URL(urls[0]).pathname, "/v1/organization/costs");
    assertEquals(q.getAll("group_by"), ["line_item", "project_id"]);
    assertEquals(q.getAll("project_ids"), ["proj_a"]);
    assertEquals(writes[0].data.totalUsd, 1);
    assertEquals(writes[0].data.groups, [
      { lineItem: "gpt-4o, input", projectId: null, usd: 1 },
    ]);
  } finally {
    restore();
  }
});

Deno.test("summarizeUsageByType counts each type's own unit field", () => {
  const results = [{
    input_tokens: 7,
    images: 2,
    characters: 300,
    seconds: 45,
    num_model_requests: 3,
  }];
  const cases = [
    ["embeddings", "input_tokens", 7],
    ["moderations", "input_tokens", 7],
    ["images", "images", 2],
    ["audio_speeches", "characters", 300],
    ["audio_transcriptions", "seconds", 45],
  ] as const;
  for (const [type, unit, quantity] of cases) {
    const s = summarizeUsageByType([{ start_time: DAY1, results }], type);
    assertEquals(s, {
      type,
      unit,
      quantity,
      requests: 3,
      daily: [{ date: "2026-10-01", quantity, requests: 3 }],
    });
  }
});

Deno.test("summarizeUsageByType groups per day and rolls up per group", () => {
  const s = summarizeUsageByType(
    [
      {
        start_time: DAY1,
        results: [
          { model: "dall-e-3", images: 1, num_model_requests: 1 },
          { model: "gpt-image-1", images: 4, num_model_requests: 2 },
        ],
      },
      {
        start_time: DAY2,
        results: [
          { model: "dall-e-3", images: 5, num_model_requests: 5 },
          { model: "gpt-image-1", images: 0, num_model_requests: 0 },
        ],
      },
    ],
    "images",
    ["model"],
  );

  assertEquals(s.quantity, 10);
  assertEquals(s.requests, 8);
  assertEquals(s.groupBy, ["model"]);
  assertEquals(s.daily[1].groups, [
    { model: "dall-e-3", quantity: 5, requests: 5 },
  ]);
  assertEquals(s.groups, [
    { model: "dall-e-3", quantity: 6, requests: 6 },
    { model: "gpt-image-1", quantity: 4, requests: 2 },
  ]);
});

Deno.test("usageByType rejects unknown types and requires type", () => {
  parseArgs("usageByType", { type: "audio_transcriptions" });
  for (const input of [{}, { type: "completions" }]) {
    let threw = false;
    try {
      parseArgs("usageByType", input);
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
  }
});

Deno.test("usageByType method hits the type endpoint and writes per-type data", async () => {
  const urls: string[] = [];
  const time = new FakeTime(NOW);
  const restore = mockFetch(urls, [
    {
      data: [{
        start_time: DAY1,
        results: [{
          project_id: "proj_a",
          input_tokens: 40,
          num_model_requests: 2,
        }],
      }],
      has_more: true,
      next_page: "page_2",
    },
    {
      data: [{
        start_time: DAY2,
        results: [{
          project_id: "proj_a",
          input_tokens: 60,
          num_model_requests: 1,
        }],
      }],
      has_more: false,
    },
  ]);
  try {
    const { ctx, writes } = fakeContext();
    await methods.usageByType.execute(
      parseArgs("usageByType", {
        type: "embeddings",
        startDate: "2026-10-01",
        groupBy: ["project_id"],
        models: ["text-embedding-3-small"],
      }),
      ctx,
    );
    assertEquals(urls.length, 2);
    assertEquals(
      new URL(urls[0]).pathname,
      "/v1/organization/usage/embeddings",
    );
    const q = query(urls[0]);
    assertEquals(q.get("start_time"), String(DAY1));
    assertEquals(q.get("bucket_width"), "1d");
    assertEquals(q.getAll("group_by"), ["project_id"]);
    assertEquals(q.getAll("models"), ["text-embedding-3-small"]);
    assertEquals(q.has("project_ids"), false);
    assertEquals(query(urls[1]).get("page"), "page_2");

    assertEquals(writes[0].spec, "usageByType");
    assertEquals(writes[0].name, "embeddings");
    const data = writes[0].data;
    assertEquals(data.type, "embeddings");
    assertEquals(data.unit, "input_tokens");
    assertEquals(data.periodStart, "2026-10-01");
    assertEquals(data.quantity, 100);
    assertEquals(data.requests, 3);
    assertEquals(data.groups, [
      { projectId: "proj_a", quantity: 100, requests: 3 },
    ]);
  } finally {
    restore();
    time.restore();
  }
});

Deno.test("API errors surface status and body", async () => {
  const urls: string[] = [];
  const restore = mockFetch(urls, [{ error: "missing scopes" }], 403);
  try {
    const { ctx } = fakeContext();
    await assertRejects(
      () => methods.costs.execute(parseArgs("costs", {}), ctx),
      Error,
      "OpenAI Usage API error (403)",
    );
  } finally {
    restore();
  }
});

Deno.test("pagination past MAX_PAGES throws instead of truncating", async () => {
  const urls: string[] = [];
  const restore = mockFetch(urls, [{
    data: [{ start_time: DAY1, results: [] }],
    has_more: true,
    next_page: "page_next",
  }]);
  try {
    const { ctx, writes } = fakeContext();
    const err = await assertRejects(
      () => methods.usage.execute(parseArgs("usage", { days: 30 }), ctx),
      Error,
      `still had more data after ${MAX_PAGES} pages`,
    );
    assertStringIncludes(err.message, "/v1/organization/usage/completions");
    assertStringIncludes(err.message, `${MAX_PAGES} bucket(s) through`);
    assertEquals(urls.length, MAX_PAGES);
    assertEquals(writes.length, 0);
  } finally {
    restore();
  }
});

Deno.test("has_more without next_page throws instead of truncating", async () => {
  const urls: string[] = [];
  const restore = mockFetch(urls, [{
    data: [{ start_time: DAY1, results: [] }],
    has_more: true,
  }]);
  try {
    const { ctx, writes } = fakeContext();
    const err = await assertRejects(
      () => methods.costs.execute(parseArgs("costs", {}), ctx),
      Error,
      "has_more without a next_page cursor after 1 page(s)",
    );
    assertStringIncludes(err.message, "/v1/organization/costs");
    assertStringIncludes(err.message, "1 bucket(s) through 2026-10-01");
    assertEquals(urls.length, 1);
    assertEquals(writes.length, 0);
  } finally {
    restore();
  }
});

Deno.test("startDate must be a real YYYY-MM-DD date", () => {
  parseArgs("usage", { startDate: "2024-02-29" });
  for (
    const bad of [
      "2026-13-01",
      "2026-02-30",
      "2025-02-29",
      "10/01/2026",
      "2026-1-1",
      "not-a-date",
    ]
  ) {
    let threw = false;
    try {
      parseArgs("usage", { startDate: bad });
    } catch {
      threw = true;
    }
    assertEquals(threw, true, `expected ${bad} to be rejected`);
  }
});

Deno.test("days is capped at MAX_DAYS on every method", () => {
  for (const m of ["usage", "usageByType", "costs"]) {
    const base = m === "usageByType" ? { type: "images" } : {};
    parseArgs(m, { ...base, days: MAX_DAYS });
    let threw = false;
    try {
      parseArgs(m, { ...base, days: MAX_DAYS + 1 });
    } catch {
      threw = true;
    }
    assertEquals(threw, true, `${m} accepted days > MAX_DAYS`);
  }
});

Deno.test("startDate range is capped and must not be in the future", async () => {
  const urls: string[] = [];
  const restore = mockFetch(urls, [{ data: [], has_more: false }]);
  const time = new FakeTime(NOW);
  try {
    const { ctx, writes } = fakeContext();
    // 2018-10-29 is exactly MAX_DAYS (2900) days before 2026-10-07: allowed.
    await methods.usage.execute(
      parseArgs("usage", { startDate: "2018-10-29" }),
      ctx,
    );
    assertEquals(writes.length, 1);
    await assertRejects(
      () =>
        methods.usage.execute(
          parseArgs("usage", { startDate: "2018-10-28" }),
          ctx,
        ),
      Error,
      `more than ${MAX_DAYS} days ago`,
    );
    await assertRejects(
      () =>
        methods.costs.execute(
          parseArgs("costs", { startDate: "2026-10-08" }),
          ctx,
        ),
      Error,
      "is in the future",
    );
    assertEquals(urls.length, 1);
  } finally {
    time.restore();
    restore();
  }
});

Deno.test("each method logs endpoint, start and groupBy on entry, never the key", async () => {
  const urls: string[] = [];
  const restore = mockFetch(urls, [{ data: [], has_more: false }]);
  const time = new FakeTime(NOW);
  try {
    const cases = [
      ["usage", { groupBy: ["model"] }, "usage/completions", "model"],
      ["usageByType", { type: "images" }, "usage/{type}", "none"],
      [
        "costs",
        { groupBy: ["line_item", "project_id"] },
        "costs",
        "line_item,project_id",
      ],
    ] as const;
    for (const [m, input, endpoint, groupBy] of cases) {
      const { ctx, logs } = fakeContext();
      await methods[m].execute(
        parseArgs(m, { startDate: "2026-10-01", ...input }),
        ctx,
      );
      assertStringIncludes(logs[0].msg, `Fetching OpenAI ${endpoint}`);
      assertEquals(logs[0].props?.start, "2026-10-01");
      assertEquals(logs[0].props?.groupBy, groupBy);
      for (const l of logs) {
        assertEquals(JSON.stringify(l).includes("test-key"), false);
      }
    }
  } finally {
    time.restore();
    restore();
  }
});

Deno.test("a 429 is retried once after Retry-After", async () => {
  const urls: string[] = [];
  const restore = mockResponses(urls, [
    new Response("slow down", {
      status: 429,
      headers: { "retry-after": "0" },
    }),
    new Response(
      JSON.stringify({
        data: [{
          start_time: DAY1,
          results: [{ amount: { value: 2, currency: "usd" } }],
        }],
        has_more: false,
      }),
    ),
  ]);
  try {
    const { ctx, writes } = fakeContext();
    await methods.costs.execute(parseArgs("costs", {}), ctx);
    assertEquals(urls.length, 2);
    assertEquals(writes[0].data.totalUsd, 2);
  } finally {
    restore();
  }
});

Deno.test("a second 429 fails with a clear rate-limit error", async () => {
  const urls: string[] = [];
  const restore = mockResponses(urls, [
    new Response("slow down", {
      status: 429,
      headers: { "retry-after": "0" },
    }),
    new Response("still slow", { status: 429 }),
  ]);
  try {
    const { ctx, writes } = fakeContext();
    await assertRejects(
      () =>
        methods.usageByType.execute(
          parseArgs("usageByType", { type: "embeddings" }),
          ctx,
        ),
      Error,
      "rate limit (429) on /v1/organization/usage/embeddings persisted after one retry",
    );
    assertEquals(urls.length, 2);
    assertEquals(writes.length, 0);
  } finally {
    restore();
  }
});

Deno.test("retryAfterMs parses seconds and dates and caps the wait", () => {
  assertEquals(retryAfterMs("2"), 2_000);
  assertEquals(retryAfterMs("120"), 30_000);
  assertEquals(retryAfterMs(null), 1_000);
  assertEquals(retryAfterMs("soon"), 1_000);
  assertEquals(retryAfterMs("Thu, 01 Jan 2015 00:00:00 GMT"), 0);
});

Deno.test("a multi-year pull that worked before the cap still works", async () => {
  const urls: string[] = [];
  const restore = mockFetch(urls, [{ data: [], has_more: false }]);
  const time = new FakeTime(NOW);
  try {
    const { ctx, writes } = fakeContext();
    await methods.usage.execute(
      parseArgs("usage", { startDate: "2025-01-01" }),
      ctx,
    );
    assertEquals(writes.length, 1);
  } finally {
    time.restore();
    restore();
  }
});
