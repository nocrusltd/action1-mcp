/**
 * Catalogue-driven access to the whole Action1 REST API.
 *
 * src/generated/action1-api.ts lists every operation in Action1's OpenAPI
 * reference with a risk tier. Calls are only made for catalogued operations,
 * and only when that tier is enabled:
 *
 *   read    — GET; always available
 *   write   — changes endpoints, groups, scripts, automations, approvals...;
 *             needs ACTION1_ENABLE_WRITES
 *   admin   — users, roles, organizations, enterprise, subscription, advanced
 *             settings, data sources, agent deployment, deleting/moving endpoints,
 *             remote sessions; needs ACTION1_ENABLE_WRITES and ACTION1_ENABLE_ADMIN
 *   blocked — never callable (enterprise closure, token minting, binary upload)
 */

import { getClient } from "./client.js";
import { adminEnabled, writesEnabled } from "./writes.js";

export type ApiTier = "read" | "write" | "admin" | "blocked";

export interface ApiQueryParam {
  name: string;
  description: string;
  enum?: unknown[];
  required?: boolean;
}

export interface ApiOperation {
  id: string;
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  tag: string;
  summary: string;
  description: string;
  permission: string;
  tier: ApiTier;
  pathParams: string[];
  queryParams: ApiQueryParam[];
  body: { required: boolean; schema: unknown } | null;
}

export interface CallArgs {
  path_params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  organization_id?: string;
  /** Required when the body targets the "ALL" endpoint group. */
  confirm_all_endpoints?: boolean;
}

/**
 * True when a request body targets the "ALL" endpoint group, i.e. every endpoint
 * in the organization. Automation instances and schedules carry targets as
 * endpoints: [{ id, type }].
 */
export function targetsAllEndpoints(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const endpoints = (body as { endpoints?: unknown }).endpoints;
  if (!Array.isArray(endpoints)) return false;
  return endpoints.some((e) => {
    const t = e as { id?: unknown; type?: unknown };
    return typeof t?.id === "string" && t.id.toUpperCase() === "ALL" && t.type !== "Endpoint";
  });
}

let catalogue: Map<string, ApiOperation> | null = null;

/** All catalogued operations, keyed by operationId. Loaded lazily (large module). */
export async function getCatalogue(): Promise<Map<string, ApiOperation>> {
  if (!catalogue) {
    const { API_OPERATIONS } = await import("../generated/action1-api.js");
    catalogue = new Map(API_OPERATIONS.map((o) => [o.id, o]));
  }
  return catalogue;
}

/** Whether a tier is callable with the current environment. */
export function tierEnabled(tier: ApiTier): boolean {
  if (tier === "read") return true;
  if (tier === "write") return writesEnabled();
  if (tier === "admin") return adminEnabled();
  return false;
}

/** Why a tier is not callable, for error messages. */
export function tierDisabledReason(tier: ApiTier): string {
  if (tier === "blocked") return "This operation is blocked in this server and cannot be called.";
  if (tier === "admin") {
    return "Admin operations need both ACTION1_ENABLE_WRITES=true and ACTION1_ENABLE_ADMIN=true.";
  }
  return "Write operations need ACTION1_ENABLE_WRITES=true.";
}

const SCALAR = new Set(["string", "number", "boolean"]);

/** Operations that start a run now and so must name at least one target. */
const TARGET_REQUIRED = new Set(["policies_instances_orgId_post"]);

/** Build the request path + query string, validating against the catalogue entry. */
export function buildRequest(
  op: ApiOperation,
  args: CallArgs,
  defaultOrgId?: string,
): { path: string; body?: string } {
  const pathParams = { ...(args.path_params ?? {}) };
  if (pathParams.orgId === undefined && op.pathParams.includes("orgId")) {
    pathParams.orgId = args.organization_id ?? defaultOrgId;
  }

  for (const key of Object.keys(pathParams)) {
    if (!op.pathParams.includes(key)) {
      throw new Error(`${op.id} has no path parameter "${key}". Expected: ${op.pathParams.join(", ") || "none"}`);
    }
  }
  let path = op.path;
  for (const name of op.pathParams) {
    const v = pathParams[name];
    if (v === undefined || v === null || v === "" || !SCALAR.has(typeof v)) {
      throw new Error(`${op.id} needs path parameter "${name}"`);
    }
    // encodeURIComponent leaves dots alone, and fetch collapses "." / ".."
    // segments, which would send the request to a different (uncatalogued) path.
    if (String(v) === "." || String(v) === "..") {
      throw new Error(`${op.id} path parameter "${name}" cannot be "." or ".."`);
    }
    path = path.replace(`{${name}}`, encodeURIComponent(String(v)));
  }

  const known = new Set(op.queryParams.map((q) => q.name));
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(args.query ?? {})) {
    if (!known.has(k)) {
      throw new Error(`${op.id} has no query parameter "${k}". Known: ${[...known].join(", ") || "none"}`);
    }
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (!v.every((x) => SCALAR.has(typeof x))) throw new Error(`query.${k} must contain only scalars`);
      qs.set(k, v.join(","));
    } else if (SCALAR.has(typeof v)) {
      qs.set(k, String(v));
    } else {
      throw new Error(`query.${k} must be a string, number, boolean or array of those`);
    }
  }
  for (const q of op.queryParams) {
    if (q.required && !qs.has(q.name)) throw new Error(`${op.id} needs query parameter "${q.name}"`);
  }

  let body: string | undefined;
  if (args.body !== undefined) {
    if (!op.body) throw new Error(`${op.id} does not take a request body`);
    body = JSON.stringify(args.body);
  } else if (op.body?.required) {
    throw new Error(`${op.id} needs a request body. Use action1_describe_api_operation to see its schema.`);
  }

  const query = qs.toString();
  return { path: `/api/3.0${path}${query ? `?${query}` : ""}`, body };
}

/**
 * Call one catalogued operation. Refuses unknown ids, blocked operations and
 * tiers that are not enabled, before any request is sent.
 */
export async function callOperation(operationId: string, args: CallArgs = {}): Promise<unknown> {
  const op = (await getCatalogue()).get(operationId);
  if (!op) throw new Error(`Unknown Action1 operation "${operationId}". Use action1_list_api_operations.`);
  if (!tierEnabled(op.tier)) throw new Error(`${op.id} (${op.tier}): ${tierDisabledReason(op.tier)}`);
  // Starting a run with no targets is refused, as the named run tools do.
  if (TARGET_REQUIRED.has(op.id)) {
    const endpoints = (args.body as { endpoints?: unknown } | undefined)?.endpoints;
    if (!Array.isArray(endpoints) || endpoints.length === 0) {
      throw new Error(`${op.id} needs a non-empty body.endpoints list of {id, type} targets`);
    }
  }
  if (targetsAllEndpoints(args.body) && args.confirm_all_endpoints !== true) {
    throw new Error(
      `${op.id} targets the "ALL" endpoint group, which is every endpoint in the organization. ` +
        "Set confirm_all_endpoints=true to proceed.",
    );
  }
  const client = getClient();
  const { path, body } = buildRequest(op, args, client.defaultOrgId);
  return client.send(op.method, path, body);
}
