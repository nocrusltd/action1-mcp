/**
 * URL + method + body pinning for the write surface of the Action1 client.
 * Same approach as action1-client.test.ts: stub global fetch and assert on
 * the literal request, because Action1 answers a wrong path with 403.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Action1Client } from "../../sdk/action1-client.js";

const EU = "https://app.eu.action1.com";
const realFetch = globalThis.fetch;

interface Captured {
  url: string;
  method: string;
  body?: string;
  contentType?: string;
}
let calls: Captured[] = [];

function stubFetch(responseBody: unknown = { items: [] }): void {
  calls = [];
  globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/oauth2/token")) {
      return new Response(
        JSON.stringify({ access_token: "t", refresh_token: "r", expires_in: 3600, token_type: "bearer" }),
        { status: 200 },
      );
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body as string | undefined,
      contentType: headers["Content-Type"],
    });
    return new Response(JSON.stringify(responseBody), { status: 200 });
  }) as typeof fetch;
}

const client = () =>
  new Action1Client({ apiKey: "k", secret: "s", region: "Europe", defaultOrgId: "org-default" });

describe("Action1Client write surface", () => {
  beforeEach(() => stubFetch());
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("creates an automation instance with a JSON POST to /policies/instances/<org>", async () => {
    const payload = {
      name: "n",
      retry_minutes: "1440",
      endpoints: [{ id: "e1", type: "Endpoint" as const }],
      actions: [{ name: "Run PowerShell", template_id: "run_script" as const, params: {} }],
    };
    await client().createAutomationInstance({ orgId: "org 1" }, payload);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${EU}/api/3.0/policies/instances/org%201`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].contentType).toBe("application/json");
    expect(JSON.parse(calls[0].body!)).toEqual(payload);
  });

  it("falls back to the default org for writes", async () => {
    await client().createAutomationInstance({}, { name: "n", retry_minutes: "1", endpoints: [], actions: [] });
    expect(calls[0].url).toBe(`${EU}/api/3.0/policies/instances/org-default`);
  });

  it("refuses writes with no org at all", async () => {
    const noOrg = new Action1Client({ apiKey: "k", secret: "s", region: "Europe" });
    await expect(
      noOrg.createAutomationInstance({}, { name: "n", retry_minutes: "1", endpoints: [], actions: [] }),
    ).rejects.toThrow(/organization_id is required/);
    expect(calls).toHaveLength(0);
  });

  it("reads instance, endpoint results and per-endpoint details from the verified paths", async () => {
    const c = client();
    await c.getAutomationInstance("inst/1", { orgId: "o" });
    await c.listAutomationEndpointResults("inst/1", { orgId: "o", limit: 500 });
    await c.getAutomationEndpointDetails("inst/1", "ep-1", { orgId: "o" });

    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([
      `GET ${EU}/api/3.0/policies/instances/o/inst%2F1`,
      `GET ${EU}/api/3.0/policies/instances/o/inst%2F1/endpoint_results?limit=500`,
      `GET ${EU}/api/3.0/automations/instances/o/inst%2F1/endpoint-results/ep-1/details`,
    ]);
  });
});

describe("Action1Client rate-limit handling", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
  });

  function stubWith429s(count: number, retryAfter = 1): { resourceCalls: () => number } {
    let n = 0;
    globalThis.fetch = vi.fn(async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/oauth2/token")) {
        return new Response(
          JSON.stringify({ access_token: "t", refresh_token: "r", expires_in: 3600, token_type: "bearer" }),
          { status: 200 },
        );
      }
      n++;
      if (n <= count) {
        return new Response(JSON.stringify({ status: 429, details: { retry_after: retryAfter } }), { status: 429 });
      }
      return new Response(JSON.stringify({ id: "ok" }), { status: 200 });
    }) as typeof fetch;
    return { resourceCalls: () => n };
  }

  it("retries a 429 after Action1's retry_after and then succeeds", async () => {
    vi.useFakeTimers();
    const stub = stubWith429s(2);
    const p = client().getAutomationInstance("i", { orgId: "o" });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toEqual({ id: "ok" });
    expect(stub.resourceCalls()).toBe(3);
  });

  it("gives up after a bounded number of retries and surfaces the 429", async () => {
    vi.useFakeTimers();
    const stub = stubWith429s(100);
    const p = client().getAutomationInstance("i", { orgId: "o" });
    const assertion = expect(p).rejects.toThrow(/429/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(stub.resourceCalls()).toBe(5);
  });

  it("caps total 429 waiting for writes at 20s so a timed-out call is not run later", async () => {
    vi.useFakeTimers();
    const stub = stubWith429s(100, 15);
    const p = client().createAutomationInstance(
      { orgId: "o" },
      { name: "n", retry_minutes: "1", endpoints: [], actions: [] },
    );
    const assertion = expect(p).rejects.toThrow(/429/);
    await vi.runAllTimersAsync();
    await assertion;
    // 15s wait fits the budget; a second 15s would reach 30s, so it stops.
    expect(stub.resourceCalls()).toBe(2);
  });

  it("allows reads a longer 60s budget", async () => {
    vi.useFakeTimers();
    const stub = stubWith429s(100, 15);
    const p = client().getAutomationInstance("i", { orgId: "o" });
    const assertion = expect(p).rejects.toThrow(/429/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(stub.resourceCalls()).toBe(5);
  });

  it("keeps Action1's error body in the final 429 message", async () => {
    vi.useFakeTimers();
    stubWith429s(100);
    const p = client().getAutomationInstance("i", { orgId: "o" });
    const assertion = expect(p).rejects.toThrow(/retry_after/);
    await vi.runAllTimersAsync();
    await assertion;
  });
});
