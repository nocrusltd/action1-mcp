#!/usr/bin/env node
/**
 * Regenerates src/generated/action1-api.ts from Action1's OpenAPI reference.
 *
 * Action1 serves the spec only inside its API docs bundle
 * (https://app.action1.com/apidocs/ — /apidocs/openapi.json returns 403), as a
 * plain object literal assigned to a const. This script downloads the bundle,
 * parses that literal with acorn and converts it to data without executing
 * anything: only object/array/literal nodes (plus `!0`/`!1` booleans and
 * negative numbers) are accepted, so a changed bundle cannot run code here.
 *
 *   node scripts/gen-api-catalogue.mjs              # fetch from app.action1.com
 *   node scripts/gen-api-catalogue.mjs spec.json    # use a local JSON spec
 *
 * Risk tiers are assigned here, in one reviewable place (see tierFor()).
 */

import fs from "node:fs";
import { parseObjectLiteralAt } from "./parse-literal.mjs";

const OUT = new URL("../src/generated/action1-api.ts", import.meta.url);
const DOCS = "https://app.action1.com/apidocs/";
const METHODS = ["get", "post", "patch", "put", "delete"];

/** Load the spec from a local JSON file (argv[2]) or from Action1's docs bundle. */
async function loadSpec() {
  const local = process.argv[2];
  if (local) return JSON.parse(fs.readFileSync(local, "utf8"));
  const html = await (await fetch(DOCS)).text();
  const m = html.match(/src="(\/apidocs\/assets\/index-[^"]+\.js)"/);
  if (!m) throw new Error("docs bundle script tag not found");
  const js = await (await fetch(new URL(m[1], DOCS))).text();
  const start = js.indexOf('{openapi:"3');
  if (start < 0) throw new Error("OpenAPI literal not found in bundle");
  return parseObjectLiteralAt(js, start);
}

// Never exposed: account closure, token minting, binary upload.
const BLOCKED = new Set([
  "enterprise_request_closure",
  "enterprise_revoke_closure",
  "oauth2_token",
  "packages_all_packageId_versions_versionId_upload_post",
  "packages_all_packageId_versions_versionId_upload_put",
]);

// Non-GET operations on these paths change who can do what, billing, tenant
// structure, or fleet enrolment: admin tier.
const ADMIN_PREFIXES = [
  "/users", "/roles", "/organizations", "/enterprise", "/subscription",
  "/settings", "/data-sources", "/endpoints/agent-deployment",
  "/endpoints/deployers", "/endpoints/deployer-installation",
];

/** Risk tier for one operation. The single place tiers are decided. */
function tierFor(method, path, id) {
  if (BLOCKED.has(id)) return "blocked";
  if (method === "get") return "read";
  if (ADMIN_PREFIXES.some((p) => path === p || path.startsWith(p + "/"))) return "admin";
  if (/^\/endpoints\/managed\/\{orgId\}\/\{endpointId\}(\/move|\/remote-sessions.*)?$/.test(path) && method !== "patch") return "admin";
  if (/remote-sessions/.test(path)) return "admin";
  return "write";
}

/** First paragraph of an operation description, without the permission line. */
function firstPara(text = "") {
  return text
    .replace(/\*\*Requires[^*]*\*\*\s*/g, "")
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0)
    ?.replace(/\s+/g, " ")
    .slice(0, 400) ?? "";
}

/** Resolve a $ref'd parameter to its definition. */
function resolveParam(spec, p) {
  if (p.$ref) return spec.components.parameters[p.$ref.split("/").pop()];
  return p;
}

const spec = await loadSpec();
const ops = [];
for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of METHODS) {
    const o = item[method];
    if (!o) continue;
    const params = [...(item.parameters ?? []), ...(o.parameters ?? [])].map((p) => resolveParam(spec, p)).filter(Boolean);
    const perm = (o.description ?? "").match(/`([a-z_]+)`/)?.[1] ?? "";
    const body = o.requestBody?.content?.["application/json"]?.schema;
    ops.push({
      id: o.operationId,
      method: method.toUpperCase(),
      path,
      tag: o.tags?.[0] ?? "",
      summary: (o.summary ?? "").replace(/^TBD:\s*/, ""),
      description: firstPara(o.description),
      permission: perm,
      tier: tierFor(method, path, o.operationId),
      // Taken from the template, not the declared params: the spec omits
      // orgId on at least one operation (PATCH .../versions/{versionId}).
      pathParams: [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]),
      queryParams: params.filter((p) => p.in === "query").map((p) => ({
        name: p.name,
        description: (p.description ?? "").replace(/\s+/g, " ").slice(0, 200),
        ...(p.schema?.enum ? { enum: p.schema.enum } : {}),
        ...(p.required ? { required: true } : {}),
      })),
      body: body ? { required: Boolean(o.requestBody.required), schema: body } : null,
    });
  }
}

const ids = new Set();
for (const op of ops) {
  if (!op.id || ids.has(op.id)) throw new Error(`missing or duplicate operationId at ${op.method} ${op.path}`);
  ids.add(op.id);
}
// If Action1 renames a blocked operation, stop rather than silently unblock it.
for (const id of BLOCKED) {
  if (!ids.has(id)) throw new Error(`BLOCKED operationId "${id}" not found in spec; review tierFor() before regenerating`);
}

const header = `// GENERATED by scripts/gen-api-catalogue.mjs from Action1's OpenAPI reference
// (${spec.info?.title ?? "Action1 API"} ${spec.info?.version ?? ""}). Do not edit by hand.
`;
const src = `${header}
import type { ApiOperation } from "../utils/operations.js";

export const API_SPEC_VERSION = ${JSON.stringify(spec.info?.version ?? "")};

export const API_OPERATIONS: ApiOperation[] = ${JSON.stringify(ops)};

/** components.schemas, for resolving request-body $refs in action1_describe_api_operation. */
export const API_SCHEMAS: Record<string, unknown> = ${JSON.stringify(spec.components.schemas)};
`;
fs.writeFileSync(OUT, src);
const counts = ops.reduce((a, o) => ((a[o.tier] = (a[o.tier] ?? 0) + 1), a), {});
console.log(`wrote ${ops.length} operations`, counts);
