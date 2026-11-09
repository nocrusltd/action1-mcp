/**
 * API domain — full Action1 REST coverage through the generated catalogue.
 *
 * Generic tools:
 *   action1_list_api_operations     — browse/search all catalogued operations
 *   action1_describe_api_operation  — parameters and request-body schema for one
 *   action1_api_read                — call any read (GET) operation
 *   action1_api_write               — call any write/admin operation (gated)
 *
 * Named tools for everyday work, built on the same gated call path:
 *   action1_search, action1_list_endpoint_missing_updates, action1_list_installed_software,
 *   action1_list_vulnerabilities, action1_list_endpoint_groups (read)
 *   action1_set_update_approval, action1_stop_automation (write)
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { DomainHandler } from "../utils/types.js";
import {
  callOperation,
  getCatalogue,
  tierEnabled,
  type ApiOperation,
  type CallArgs,
} from "../utils/operations.js";
import { writesEnabled, WRITES_DISABLED_MESSAGE } from "../utils/writes.js";

const orgProp = {
  type: "string",
  description:
    'Organization id, or "all" for every organization you can access. Defaults to ACTION1_DEFAULT_ORG_ID.',
} as const;

const pageProps = {
  limit: { type: "number", minimum: 1, description: "Page size." },
  from: { type: "number", minimum: 0, description: "Offset of the first item." },
  filter: { type: "string", description: "Action1 filter expression." },
} as const;

const callProps = {
  operation_id: { type: "string", description: "operationId from action1_list_api_operations." },
  organization_id: orgProp,
  path_params: {
    type: "object",
    description: "Path parameters other than orgId, e.g. {\"endpointId\": \"...\"}.",
    additionalProperties: true,
  },
  query: {
    type: "object",
    description: "Query parameters. Only names the operation declares are accepted.",
    additionalProperties: true,
  },
} as const;

const readAnn = { readOnlyHint: true, openWorldHint: true } as const;
const writeAnn = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

const readTools: Tool[] = [
  {
    name: "action1_list_api_operations",
    description:
      "List every Action1 API operation this server can call, with its risk tier (read / write / admin / blocked) " +
      "and whether that tier is enabled. Filter by search text, tag or tier.",
    annotations: { title: "List Action1 API operations", ...readAnn },
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string", description: "Case-insensitive match on id, path, summary or description." },
        tag: { type: "string", description: "Exact tag, e.g. \"Endpoints\"." },
        tier: { type: "string", enum: ["read", "write", "admin", "blocked"] },
      },
    },
  },
  {
    name: "action1_describe_api_operation",
    description:
      "Show one Action1 API operation in full: method, path, required permission, path and query parameters, " +
      "and the request-body JSON schema (with $refs resolved). Call this before action1_api_write.",
    annotations: { title: "Describe an Action1 API operation", ...readAnn },
    inputSchema: {
      type: "object",
      properties: { operation_id: callProps.operation_id },
      required: ["operation_id"],
    },
  },
  {
    name: "action1_api_read",
    description:
      "Call any read-only (GET) Action1 API operation by operationId. Covers reports, audit log, scripts, " +
      "software repository, schedules, vulnerabilities, users, roles, settings and the rest of the API.",
    annotations: { title: "Call an Action1 read operation", ...readAnn },
    inputSchema: { type: "object", properties: callProps, required: ["operation_id"] },
  },
  {
    name: "action1_search",
    description: "Search an Action1 organization (endpoints, software, updates and more) by text.",
    annotations: { title: "Search Action1", ...readAnn },
    inputSchema: {
      type: "object",
      properties: { organization_id: orgProp, query: { type: "string" }, limit: pageProps.limit },
      required: ["query"],
    },
  },
  {
    name: "action1_list_endpoint_missing_updates",
    description:
      "List the updates missing on ONE endpoint (per-device patch status). Filter by approval_status or security_severity.",
    annotations: { title: "Missing updates on an endpoint", ...readAnn },
    inputSchema: {
      type: "object",
      properties: {
        organization_id: orgProp,
        endpoint_id: { type: "string" },
        approval_status: { type: "string", description: "e.g. New, Approved, Declined." },
        security_severity: { type: "string", description: "e.g. Critical, Important." },
        ...pageProps,
      },
      required: ["endpoint_id"],
    },
  },
  {
    name: "action1_list_installed_software",
    description:
      "List installed software across an organization, or on one endpoint when endpoint_id is given.",
    annotations: { title: "Installed software", ...readAnn },
    inputSchema: {
      type: "object",
      properties: { organization_id: orgProp, endpoint_id: { type: "string" }, ...pageProps },
    },
  },
  {
    name: "action1_list_vulnerabilities",
    description:
      "List vulnerabilities (CVEs) detected in an organization. Optionally narrow to one endpoint or CVE ids.",
    annotations: { title: "Vulnerabilities", ...readAnn },
    inputSchema: {
      type: "object",
      properties: {
        organization_id: orgProp,
        endpoint_id: { type: "string" },
        CVEIDs: { type: "string", description: "Comma-separated CVE ids." },
        remediation_status: { type: "string" },
        ...pageProps,
      },
    },
  },
  {
    name: "action1_list_endpoint_groups",
    description: "List endpoint groups in an organization (use the ids as endpoint_group_ids in write tools).",
    annotations: { title: "Endpoint groups", ...readAnn },
    inputSchema: { type: "object", properties: { organization_id: orgProp, ...pageProps } },
  },
];

const writeTools: Tool[] = [
  {
    name: "action1_api_write",
    description:
      "Call any write or admin Action1 API operation by operationId (create/update/delete groups, scripts, " +
      "schedules, packages, remediations, users, roles, settings...). Use action1_describe_api_operation first " +
      "for the body schema. Admin operations also need ACTION1_ENABLE_ADMIN=true. Blocked operations are never called.",
    annotations: { title: "Call an Action1 write operation", ...writeAnn },
    inputSchema: {
      type: "object",
      properties: {
        ...callProps,
        body: { description: "JSON request body, per the operation's schema." },
        confirm_all_endpoints: {
          type: "boolean",
          description: 'Must be true when the body targets the "ALL" endpoint group (every endpoint in the organization).',
        },
      },
      required: ["operation_id"],
    },
  },
  {
    name: "action1_set_update_approval",
    description:
      "Approve, decline or reset (New) updates. Package and version ids come from action1_list_missing_updates " +
      "(item id and versions[].id).",
    annotations: { title: "Set update approval", ...writeAnn },
    inputSchema: {
      type: "object",
      properties: {
        organization_id: orgProp,
        approval_status: { type: "string", enum: ["Approved", "Declined", "New"] },
        packages: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: { package_id: { type: "string" }, version_id: { type: "string" } },
            required: ["package_id", "version_id"],
          },
        },
      },
      required: ["approval_status", "packages"],
    },
  },
  {
    name: "action1_stop_automation",
    description: "Stop a running automation instance (e.g. one started by action1_run_script).",
    annotations: { title: "Stop an automation", ...writeAnn },
    inputSchema: {
      type: "object",
      properties: { organization_id: orgProp, instance_id: { type: "string" } },
      required: ["instance_id"],
    },
  },
];

const WRITE_NAMES = new Set(writeTools.map((t) => t.name));

/** Text result helper. */
function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/** Required non-empty string argument. */
function req(args: Record<string, unknown>, field: string): string {
  const v = args[field];
  if (typeof v !== "string" || !v.trim()) throw new Error(`${field} is required`);
  return v;
}

/** Copy only the defined values of the named keys. */
function pick(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (args[k] !== undefined) out[k] = args[k];
  return out;
}

/** Validate the generic call arguments into CallArgs. */
function callArgs(args: Record<string, unknown>): CallArgs {
  for (const k of ["path_params", "query"] as const) {
    const v = args[k];
    if (v !== undefined && (typeof v !== "object" || v === null || Array.isArray(v))) {
      throw new Error(`${k} must be an object`);
    }
  }
  return {
    organization_id: args.organization_id as string | undefined,
    path_params: args.path_params as Record<string, unknown> | undefined,
    query: args.query as Record<string, unknown> | undefined,
    body: args.body,
    confirm_all_endpoints: args.confirm_all_endpoints === true,
  };
}

/** Resolve "#/components/schemas/X" refs, depth-limited so recursive schemas terminate. */
export function resolveRefs(node: unknown, schemas: Record<string, unknown>, depth = 0): unknown {
  if (Array.isArray(node)) return node.map((n) => resolveRefs(n, schemas, depth));
  if (!node || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === "string") {
    const name = obj.$ref.split("/").pop() as string;
    if (depth >= 4 || !(name in schemas)) return { $ref: obj.$ref };
    return resolveRefs(schemas[name], schemas, depth + 1);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "example" || k === "examples") continue;
    out[k] = resolveRefs(v, schemas, depth);
  }
  return out;
}

/** Look up an operation or throw. */
async function getOp(id: string): Promise<ApiOperation> {
  const op = (await getCatalogue()).get(id);
  if (!op) throw new Error(`Unknown Action1 operation "${id}". Use action1_list_api_operations.`);
  return op;
}

export const apiHandler: DomainHandler = {
  get tools() {
    return writesEnabled() ? [...readTools, ...writeTools] : readTools;
  },
  async handle(name, args) {
    if (WRITE_NAMES.has(name) && !writesEnabled()) throw new Error(WRITES_DISABLED_MESSAGE);

    switch (name) {
      case "action1_list_api_operations": {
        const search = typeof args.search === "string" ? args.search.toLowerCase() : "";
        const ops = [...(await getCatalogue()).values()].filter(
          (o) =>
            (!args.tag || o.tag === args.tag) &&
            (!args.tier || o.tier === args.tier) &&
            (!search ||
              [o.id, o.path, o.summary, o.description].some((f) => f.toLowerCase().includes(search))),
        );
        return json({
          count: ops.length,
          operations: ops.map((o) => ({
            id: o.id,
            method: o.method,
            path: o.path,
            tag: o.tag,
            summary: o.summary,
            tier: o.tier,
            enabled: tierEnabled(o.tier),
          })),
        });
      }

      case "action1_describe_api_operation": {
        const op = await getOp(req(args, "operation_id"));
        const { API_SCHEMAS } = await import("../generated/action1-api.js");
        return json({
          ...op,
          enabled: tierEnabled(op.tier),
          body: op.body ? { required: op.body.required, schema: resolveRefs(op.body.schema, API_SCHEMAS) } : null,
        });
      }

      case "action1_api_read": {
        const op = await getOp(req(args, "operation_id"));
        if (op.tier !== "read") {
          throw new Error(`${op.id} is a ${op.tier} operation. Use action1_api_write for anything that changes state.`);
        }
        return json(await callOperation(op.id, callArgs(args)));
      }

      case "action1_api_write": {
        const op = await getOp(req(args, "operation_id"));
        if (op.tier === "read") {
          throw new Error(`${op.id} is read-only. Use action1_api_read.`);
        }
        return json(await callOperation(op.id, callArgs(args)));
      }

      case "action1_search":
        return json(
          await callOperation("search", {
            organization_id: args.organization_id as string | undefined,
            query: pick(args, ["query", "limit"]),
          }),
        );

      case "action1_list_endpoint_missing_updates":
        return json(
          await callOperation("endpoints_managed_endpointId_missing_updates", {
            organization_id: args.organization_id as string | undefined,
            path_params: { endpointId: req(args, "endpoint_id") },
            query: pick(args, ["approval_status", "security_severity", "limit", "from", "filter"]),
          }),
        );

      case "action1_list_installed_software": {
        const endpointId = args.endpoint_id;
        if (endpointId !== undefined && (typeof endpointId !== "string" || !endpointId.trim())) {
          throw new Error("endpoint_id must be a non-empty string");
        }
        return json(
          await callOperation(endpointId ? "apps_orgId_data_endpointId_get" : "apps_orgId_data_get", {
            organization_id: args.organization_id as string | undefined,
            ...(endpointId ? { path_params: { endpointId } } : {}),
            query: pick(args, ["limit", "from", "filter"]),
          }),
        );
      }

      case "action1_list_vulnerabilities":
        return json(
          await callOperation("vulnerabilities_orgId_get", {
            organization_id: args.organization_id as string | undefined,
            query: pick(args, ["endpoint_id", "CVEIDs", "remediation_status", "limit", "from", "filter"]),
          }),
        );

      case "action1_list_endpoint_groups":
        return json(
          await callOperation("endpoints_groups_orgId", {
            organization_id: args.organization_id as string | undefined,
            query: pick(args, ["limit", "from", "filter"]),
          }),
        );

      case "action1_set_update_approval": {
        const status = req(args, "approval_status");
        if (!["Approved", "Declined", "New"].includes(status)) {
          throw new Error("approval_status must be Approved, Declined or New");
        }
        const packages = args.packages;
        if (!Array.isArray(packages) || packages.length === 0) {
          throw new Error("packages must be a non-empty array of {package_id, version_id}");
        }
        const mapped = packages.map((p, i) => {
          const pkg = p as Record<string, unknown>;
          if (typeof pkg?.package_id !== "string" || typeof pkg?.version_id !== "string") {
            throw new Error(`packages[${i}] needs string package_id and version_id`);
          }
          // Action1's ApprovalPackage field is literally "packages_id".
          return { packages_id: pkg.package_id, version_id: pkg.version_id };
        });
        return json(
          await callOperation("updates_orgId_approvals", {
            organization_id: args.organization_id as string | undefined,
            body: [{ approval_status: status, packages: mapped }],
          }),
        );
      }

      case "action1_stop_automation":
        return json(
          await callOperation("policies_instances_orgId_instanceId_stop_post", {
            organization_id: args.organization_id as string | undefined,
            path_params: { instanceId: req(args, "instance_id") },
          }),
        );

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  },
};

