import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiHandler, resolveRefs } from "../../domains/api.js";
import { Action1Client } from "../../sdk/action1-client.js";
import * as clientModule from "../../utils/client.js";

const saved = { w: process.env.ACTION1_ENABLE_WRITES, a: process.env.ACTION1_ENABLE_ADMIN };
function env(writes?: string, admin?: string): void {
  if (writes === undefined) delete process.env.ACTION1_ENABLE_WRITES;
  else process.env.ACTION1_ENABLE_WRITES = writes;
  if (admin === undefined) delete process.env.ACTION1_ENABLE_ADMIN;
  else process.env.ACTION1_ENABLE_ADMIN = admin;
}

const realFetch = globalThis.fetch;
let calls: Array<{ method: string; url: string; body?: string }> = [];
let responder: () => Response = () => new Response("[]", { status: 200 });

/** Real client + real operations layer; only global fetch is stubbed. */
function wireRealClient(): void {
  calls = [];
  globalThis.fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "t", refresh_token: "r", expires_in: 3600, token_type: "bearer" }));
    }
    calls.push({ method: init?.method ?? "GET", url, body: init?.body as string | undefined });
    return responder();
  }) as typeof fetch;
  const client = new Action1Client({ apiKey: "k", secret: "s", region: "Europe", defaultOrgId: "org-1" });
  vi.spyOn(clientModule, "getClient").mockReturnValue(client);
}

const EU = "https://app.eu.action1.com/api/3.0";
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text);

describe("api domain", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    responder = () => new Response("[]", { status: 200 });
    wireRealClient();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    env(saved.w, saved.a);
  });

  describe("tool listing", () => {
    it("hides write tools by default and shows them with writes on", () => {
      env(undefined);
      const ro = apiHandler.tools.map((t) => t.name);
      expect(ro).toContain("action1_api_read");
      expect(ro).not.toContain("action1_api_write");
      expect(ro).not.toContain("action1_set_update_approval");
      env("true");
      expect(apiHandler.tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(["action1_api_write", "action1_set_update_approval", "action1_stop_automation"]),
      );
    });

    it("refuses write tools by name when writes are off", async () => {
      env(undefined);
      await expect(apiHandler.handle("action1_stop_automation", { instance_id: "i" })).rejects.toThrow(/disabled/);
      expect(calls).toHaveLength(0);
    });
  });

  describe("generic tools", () => {
    it("lists operations with tier and enabled flag", async () => {
      env(undefined);
      const body = parse(await apiHandler.handle("action1_list_api_operations", { tier: "admin" }));
      expect(body.count).toBe(27);
      expect(body.operations.every((o: { enabled: boolean }) => o.enabled === false)).toBe(true);
    });

    it("describes an operation with $refs resolved", async () => {
      const body = parse(await apiHandler.handle("action1_describe_api_operation", { operation_id: "updates_orgId_approvals" }));
      expect(body.method).toBe("POST");
      expect(JSON.stringify(body.body.schema)).toContain("packages_id");
      expect(JSON.stringify(body.body.schema)).not.toContain("$ref");
    });

    it("api_read calls a GET and refuses non-read operations", async () => {
      await apiHandler.handle("action1_api_read", { operation_id: "audit_events_get", query: { limit: 3 } });
      expect(calls).toEqual([{ method: "GET", url: `${EU}/audit/events?limit=3`, body: undefined }]);
      await expect(
        apiHandler.handle("action1_api_read", { operation_id: "users_post", body: {} }),
      ).rejects.toThrow(/Use action1_api_write/);
      expect(calls).toHaveLength(1);
    });

    it("api_write refuses read operations and gated tiers", async () => {
      env("true");
      await expect(apiHandler.handle("action1_api_write", { operation_id: "audit_events_get" })).rejects.toThrow(/read-only/);
      await expect(
        apiHandler.handle("action1_api_write", { operation_id: "users_post", body: {} }),
      ).rejects.toThrow(/ACTION1_ENABLE_ADMIN/);
      await expect(
        apiHandler.handle("action1_api_write", { operation_id: "enterprise_request_closure" }),
      ).rejects.toThrow(/blocked/);
      expect(calls).toHaveLength(0);
    });

    it("api_write sends a write with its JSON body", async () => {
      env("true");
      await apiHandler.handle("action1_api_write", {
        operation_id: "endpoints_groups",
        body: { name: "Sage PCs" },
      });
      expect(calls).toEqual([{ method: "POST", url: `${EU}/endpoints/groups/org-1`, body: '{"name":"Sage PCs"}' }]);
    });

    it("passes confirm_all_endpoints through to the ALL guard", async () => {
      env("true");
      const body = { name: "n", retry_minutes: "1", endpoints: [{ id: "ALL", type: "EndpointGroup" }], actions: [] };
      await expect(
        apiHandler.handle("action1_api_write", { operation_id: "policies_instances_orgId_post", body }),
      ).rejects.toThrow(/confirm_all_endpoints/);
      expect(calls).toHaveLength(0);
      await apiHandler.handle("action1_api_write", {
        operation_id: "policies_instances_orgId_post",
        body,
        confirm_all_endpoints: true,
      });
      expect(calls).toHaveLength(1);
    });

    it("rejects non-object path_params / query", async () => {
      await expect(
        apiHandler.handle("action1_api_read", { operation_id: "audit_events_get", query: "limit=3" }),
      ).rejects.toThrow(/query must be an object/);
    });

    it("returns non-JSON responses (e.g. CSV exports) as text", async () => {
      responder = () => new Response("a,b\n1,2\n", { status: 200, headers: { "Content-Type": "text/csv" } });
      const r = await apiHandler.handle("action1_api_read", { operation_id: "audit_export_get" });
      expect(JSON.parse(r.content[0].text)).toBe("a,b\n1,2\n");
    });
  });

  describe("named tools hit the documented paths", () => {
    it("per-endpoint missing updates", async () => {
      await apiHandler.handle("action1_list_endpoint_missing_updates", { endpoint_id: "ep-1", security_severity: "Critical" });
      expect(calls[0].url).toBe(`${EU}/endpoints/managed/org-1/ep-1/missing-updates?security_severity=Critical`);
    });

    it("installed software, org-wide and per endpoint", async () => {
      await apiHandler.handle("action1_list_installed_software", {});
      await apiHandler.handle("action1_list_installed_software", { endpoint_id: "ep-1", limit: 10 });
      expect(calls.map((c) => c.url)).toEqual([
        `${EU}/installed-software/org-1/data`,
        `${EU}/installed-software/org-1/data/ep-1?limit=10`,
      ]);
    });

    it("vulnerabilities, groups and search", async () => {
      await apiHandler.handle("action1_list_vulnerabilities", { endpoint_id: "ep-1" });
      await apiHandler.handle("action1_list_endpoint_groups", { organization_id: "all" });
      await apiHandler.handle("action1_search", { query: "sage" });
      expect(calls.map((c) => c.url)).toEqual([
        `${EU}/vulnerabilities/org-1?endpoint_id=ep-1`,
        `${EU}/endpoints/groups/all`,
        `${EU}/search/org-1?query=sage`,
      ]);
    });

    it("set_update_approval maps to Action1's packages_id field", async () => {
      env("true");
      await apiHandler.handle("action1_set_update_approval", {
        approval_status: "Approved",
        packages: [{ package_id: "Google_Chrome_builtin", version_id: "v1" }],
      });
      expect(calls[0].method).toBe("POST");
      expect(calls[0].url).toBe(`${EU}/updates/org-1/approvals`);
      expect(JSON.parse(calls[0].body!)).toEqual([
        { approval_status: "Approved", packages: [{ packages_id: "Google_Chrome_builtin", version_id: "v1" }] },
      ]);
    });

    it("set_update_approval validates input before sending", async () => {
      env("true");
      await expect(
        apiHandler.handle("action1_set_update_approval", { approval_status: "Yes", packages: [{ package_id: "p", version_id: "v" }] }),
      ).rejects.toThrow(/approval_status/);
      await expect(
        apiHandler.handle("action1_set_update_approval", { approval_status: "Approved", packages: [{ package_id: "p" }] }),
      ).rejects.toThrow(/packages\[0\]/);
      expect(calls).toHaveLength(0);
    });

    it("stop_automation", async () => {
      env("true");
      await apiHandler.handle("action1_stop_automation", { instance_id: "inst 1" });
      expect(calls[0]).toEqual({ method: "POST", url: `${EU}/automations/instances/org-1/inst%201/stop`, body: undefined });
    });
  });

  describe("resolveRefs", () => {
    it("stops at depth 4 on recursive schemas", () => {
      const schemas = { A: { properties: { next: { $ref: "#/components/schemas/A" } } } };
      const out = JSON.stringify(resolveRefs({ $ref: "#/components/schemas/A" }, schemas));
      expect(out).toContain('"$ref":"#/components/schemas/A"');
    });
  });
});
