/**
 * Catalogue integrity, tier gating and request building for the full-API path.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { API_OPERATIONS } from "../../generated/action1-api.js";
import { buildRequest, callOperation, getCatalogue, tierEnabled, type ApiOperation } from "../../utils/operations.js";
import * as clientModule from "../../utils/client.js";

const saved = { w: process.env.ACTION1_ENABLE_WRITES, a: process.env.ACTION1_ENABLE_ADMIN };
function env(writes?: string, admin?: string): void {
  if (writes === undefined) delete process.env.ACTION1_ENABLE_WRITES;
  else process.env.ACTION1_ENABLE_WRITES = writes;
  if (admin === undefined) delete process.env.ACTION1_ENABLE_ADMIN;
  else process.env.ACTION1_ENABLE_ADMIN = admin;
}
const op = (id: string): ApiOperation => {
  const found = API_OPERATIONS.find((o) => o.id === id);
  if (!found) throw new Error(`fixture op ${id} missing from catalogue`);
  return found;
};

describe("generated catalogue", () => {
  it("covers the whole Action1 API (141 operations, unique ids)", () => {
    expect(API_OPERATIONS).toHaveLength(141);
    expect(new Set(API_OPERATIONS.map((o) => o.id)).size).toBe(141);
  });

  it("declares exactly the path parameters each path template uses", () => {
    for (const o of API_OPERATIONS) {
      const inPath = [...o.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).sort();
      expect([...o.pathParams].sort(), `${o.method} ${o.path}`).toEqual(inPath);
    }
  });

  it("makes every GET read-tier and nothing else read-tier", () => {
    for (const o of API_OPERATIONS) {
      if (o.tier === "blocked") continue;
      expect(o.tier === "read", `${o.method} ${o.path} is ${o.tier}`).toBe(o.method === "GET");
    }
  });

  it("blocks exactly account closure, token minting and binary upload", () => {
    expect(API_OPERATIONS.filter((o) => o.tier === "blocked").map((o) => o.id).sort()).toEqual([
      "enterprise_request_closure",
      "enterprise_revoke_closure",
      "oauth2_token",
      "packages_all_packageId_versions_versionId_upload_post",
      "packages_all_packageId_versions_versionId_upload_put",
    ]);
  });

  it.each([
    "users_post",
    "users_userId_delete",
    "roles__roleId__users_userId_post",
    "organizations__orgId__delete",
    "enterprise_patch",
    "settings_orgId_post",
    "endpoints_managed_endpointId_delete",
    "endpoints_managed_endpointId_move",
    "endpoints_managed_endpointId_remote_sessions_post",
    "endpoints_discovery_orgId_patch",
  ])("puts %s in the admin tier", (id) => {
    expect(op(id).tier).toBe("admin");
  });

  it.each([
    "policies_instances_orgId_post",
    "policies_instances_orgId_instanceId_stop_post",
    "updates_orgId_approvals",
    "endpoints_groups",
    "scripts_orgId_post",
    "endpoints_managed_endpointId_patch",
  ])("puts %s in the write tier", (id) => {
    expect(op(id).tier).toBe("write");
  });
});

describe("tierEnabled", () => {
  afterEach(() => env(saved.w, saved.a));

  it.each([
    [undefined, undefined, { read: true, write: false, admin: false, blocked: false }],
    ["true", undefined, { read: true, write: true, admin: false, blocked: false }],
    [undefined, "true", { read: true, write: false, admin: false, blocked: false }],
    ["true", "true", { read: true, write: true, admin: true, blocked: false }],
    ["1", "1", { read: true, write: true, admin: true, blocked: false }],
  ])("writes=%s admin=%s", (w, a, expected) => {
    env(w, a);
    for (const [tier, on] of Object.entries(expected)) {
      expect(tierEnabled(tier as never), tier).toBe(on);
    }
  });
});

describe("buildRequest", () => {
  it("substitutes and encodes path params, defaulting orgId", () => {
    expect(
      buildRequest(op("endpoints_managed_endpointId_missing_updates"), { path_params: { endpointId: "a/b" } }, "org-1"),
    ).toEqual({ path: "/api/3.0/endpoints/managed/org-1/a%2Fb/missing-updates", body: undefined });
  });

  it("prefers organization_id over the default and accepts 'all'", () => {
    expect(buildRequest(op("endpoints_groups_orgId"), { organization_id: "all" }, "org-1").path).toBe(
      "/api/3.0/endpoints/groups/all",
    );
  });

  it("rejects unknown and missing path params", () => {
    expect(() => buildRequest(op("endpoints_groups_orgId"), { path_params: { nope: "x" } }, "o")).toThrow(/no path parameter "nope"/);
    expect(() => buildRequest(op("endpoints_managed_endpointId_missing_updates"), {}, "o")).toThrow(/needs path parameter "endpointId"/);
    expect(() => buildRequest(op("endpoints_groups_orgId"), {}, undefined)).toThrow(/needs path parameter "orgId"/);
  });

  it("serialises known query params and rejects unknown ones", () => {
    const r = buildRequest(op("vulnerabilities_orgId_get"), { query: { limit: 5, CVEIDs: ["CVE-1", "CVE-2"] } }, "o");
    expect(r.path).toBe("/api/3.0/vulnerabilities/o?limit=5&CVEIDs=CVE-1%2CCVE-2");
    expect(() => buildRequest(op("vulnerabilities_orgId_get"), { query: { bogus: 1 } }, "o")).toThrow(/no query parameter "bogus"/);
    expect(() => buildRequest(op("vulnerabilities_orgId_get"), { query: { limit: { a: 1 } } }, "o")).toThrow(/query.limit/);
  });

  it("enforces required query params", () => {
    expect(() => buildRequest(op("search"), {}, "o")).toThrow(/needs query parameter "query"/);
  });

  it("rejects a body where none is accepted, and requires one where needed", () => {
    expect(() => buildRequest(op("endpoints_groups_orgId"), { body: {} }, "o")).toThrow(/does not take a request body/);
    expect(() => buildRequest(op("updates_orgId_approvals"), {}, "o")).toThrow(/needs a request body/);
    expect(buildRequest(op("updates_orgId_approvals"), { body: [{ a: 1 }] }, "o").body).toBe('[{"a":1}]');
  });
});

describe("callOperation gating (no request is sent when refused)", () => {
  let send: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.restoreAllMocks();
    send = vi.fn().mockResolvedValue({ ok: true });
    vi.spyOn(clientModule, "getClient").mockReturnValue({ send, defaultOrgId: "org-1" } as never);
  });
  afterEach(() => env(saved.w, saved.a));

  it("refuses unknown operations", async () => {
    await expect(callOperation("nope")).rejects.toThrow(/Unknown Action1 operation/);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses blocked operations even with writes and admin on", async () => {
    env("true", "true");
    await expect(callOperation("enterprise_request_closure")).rejects.toThrow(/blocked/);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses admin operations with writes alone", async () => {
    env("true", undefined);
    await expect(callOperation("users_userId_delete", { path_params: { userId: "u" } })).rejects.toThrow(/ACTION1_ENABLE_ADMIN/);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses write operations by default", async () => {
    env(undefined, undefined);
    await expect(
      callOperation("policies_instances_orgId_instanceId_stop_post", { path_params: { instanceId: "i" } }),
    ).rejects.toThrow(/ACTION1_ENABLE_WRITES/);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends allowed operations with the catalogue method and path", async () => {
    env("true", "true");
    await callOperation("users_userId_delete", { path_params: { userId: "u 1" } });
    expect(send).toHaveBeenCalledWith("DELETE", "/api/3.0/users/u%201", undefined);
  });

  it("loads the catalogue once", async () => {
    expect(await getCatalogue()).toBe(await getCatalogue());
  });
});

describe("dot-segment path values", () => {
  it.each([".", ".."])("rejects %j so fetch cannot collapse the path", (v) => {
    const scriptDelete = API_OPERATIONS.find((o) => o.id === "scripts_orgId_scriptId_delete")!;
    expect(() => buildRequest(scriptDelete, { path_params: { scriptId: v } }, "o")).toThrow(/cannot be "\." or "\.\."/);
  });

  it("still allows ids that merely contain dots", () => {
    const scriptDelete = API_OPERATIONS.find((o) => o.id === "scripts_orgId_scriptId_delete")!;
    expect(buildRequest(scriptDelete, { path_params: { scriptId: "a..b" } }, "o").path).toBe("/api/3.0/scripts/all/a..b");
  });
});

describe("ALL-endpoints confirmation on generic calls", () => {
  let send: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.restoreAllMocks();
    send = vi.fn().mockResolvedValue({ ok: true });
    vi.spyOn(clientModule, "getClient").mockReturnValue({ send, defaultOrgId: "org-1" } as never);
    env("true", undefined);
  });
  afterEach(() => env(saved.w, saved.a));

  const allBody = { name: "x", retry_minutes: "1", endpoints: [{ id: "ALL", type: "EndpointGroup" }], actions: [] };

  it.each(["policies_instances_orgId_post", "policies_schedules_orgId_post"])(
    "refuses %s targeting ALL without confirmation",
    async (id) => {
      await expect(callOperation(id, { body: allBody })).rejects.toThrow(/confirm_all_endpoints/);
      await expect(
        callOperation(id, { body: { ...allBody, endpoints: [{ id: "all", type: "EndpointGroup" }] } }),
      ).rejects.toThrow(/confirm_all_endpoints/);
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("sends when confirmed, or when targeting specific endpoints", async () => {
    await callOperation("policies_instances_orgId_post", { body: allBody, confirm_all_endpoints: true });
    await callOperation("policies_instances_orgId_post", {
      body: { ...allBody, endpoints: [{ id: "e1", type: "Endpoint" }] },
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
