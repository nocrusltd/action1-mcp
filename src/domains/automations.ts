/**
 * Automations domain — start one-off ("run now") automations and read their results.
 *
 * Write tools (gated by ACTION1_ENABLE_WRITES, see src/utils/writes.ts):
 *   action1_run_script        — run an inline PowerShell / Command / Bash script
 *   action1_reboot_endpoints  — reboot endpoints, optionally warning the user first
 *   action1_deploy_updates    — deploy specific updates from action1_list_missing_updates
 *
 * Read tool (always available):
 *   action1_get_automation_results — per-endpoint status plus script output
 *
 * Payload shapes follow the RunScript / Reboot / DeployUpdateSpecified schemas
 * in the Action1 OpenAPI reference (https://app.action1.com/apidocs/).
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { DomainHandler } from "../utils/types.js";
import { getClient } from "../utils/client.js";
import { writesEnabled, WRITES_DISABLED_MESSAGE } from "../utils/writes.js";
import type {
  AutomationAction,
  AutomationTarget,
} from "../sdk/action1-client.js";

const DEFAULT_REBOOT_MESSAGE =
  "Your computer requires maintenance and will be rebooted. Please save all work and reboot now to avoid losing any data.";

const orgProp = {
  type: "string",
  description: "Organization id. Defaults to ACTION1_DEFAULT_ORG_ID from credentials if omitted.",
} as const;

const targetProps = {
  endpoint_ids: {
    type: "array",
    items: { type: "string" },
    description: "Endpoint ids from action1_list_endpoints.",
  },
  endpoint_group_ids: {
    type: "array",
    items: { type: "string" },
    description:
      'Endpoint group ids. "ALL" targets every endpoint in the organization and also requires confirm_all_endpoints=true.',
  },
  confirm_all_endpoints: {
    type: "boolean",
    description: 'Must be true when endpoint_group_ids contains "ALL".',
  },
  retry_minutes: {
    type: "number",
    description:
      "How long Action1 keeps trying offline endpoints, in minutes (default 1440 = 24h).",
    minimum: 1,
  },
} as const;

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const writeTools: Tool[] = [
  {
    name: "action1_run_script",
    description:
      "Run a script now on Action1 endpoints (runs as SYSTEM on Windows). Returns the automation instance id; " +
      "poll action1_get_automation_results for per-endpoint status and output. " +
      "Offline endpoints run it when they reconnect, within retry_minutes.",
    annotations: { title: "Run script on endpoints", ...writeAnnotations },
    inputSchema: {
      type: "object",
      properties: {
        organization_id: orgProp,
        ...targetProps,
        name: { type: "string", description: "Automation name shown in the Action1 console." },
        script_text: { type: "string", description: "The script body." },
        language: {
          type: "string",
          enum: ["PowerShell", "Command", "Bash"],
          description: "Script language (default PowerShell).",
        },
        reboot_after: {
          type: "boolean",
          description: "Reboot the endpoint after the script (default false).",
        },
      },
      required: ["name", "script_text"],
    },
  },
  {
    name: "action1_reboot_endpoints",
    description:
      "Reboot Action1 endpoints now. By default users see a warning and the reboot happens after timeout_minutes.",
    annotations: { title: "Reboot endpoints", ...writeAnnotations },
    inputSchema: {
      type: "object",
      properties: {
        organization_id: orgProp,
        ...targetProps,
        name: { type: "string", description: "Automation name (default \"Reboot\")." },
        show_message: { type: "boolean", description: "Warn the logged-in user first (default true)." },
        message_text: { type: "string", description: "Warning text shown to the user." },
        timeout_minutes: {
          type: "number",
          description: "Minutes between the warning and the forced reboot (default 240).",
          minimum: 1,
        },
      },
    },
  },
  {
    name: "action1_deploy_updates",
    description:
      "Deploy specific updates now. Take package ids and versions from action1_list_missing_updates " +
      "(item id, and versions[].version). Does not reboot unless reboot_after is true.",
    annotations: { title: "Deploy updates to endpoints", ...writeAnnotations },
    inputSchema: {
      type: "object",
      properties: {
        organization_id: orgProp,
        ...targetProps,
        name: { type: "string", description: "Automation name shown in the Action1 console." },
        packages: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              package_id: { type: "string" },
              version: { type: "string" },
            },
            required: ["package_id", "version"],
          },
          description: "Updates to deploy.",
        },
        reboot_after: {
          type: "boolean",
          description: "Reboot after installing if needed, with a user warning (default false).",
        },
      },
      required: ["name", "packages"],
    },
  },
];

const readTools: Tool[] = [
  {
    name: "action1_get_automation_results",
    description:
      "Get the status of an automation instance (e.g. from action1_run_script) with one row per endpoint, " +
      "including script output lines when include_output is true.",
    annotations: { title: "Get automation results", readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        organization_id: orgProp,
        instance_id: { type: "string", description: "Automation instance id." },
        include_output: {
          type: "boolean",
          description: "Fetch each endpoint's step log, which holds script output (default true).",
        },
      },
      required: ["instance_id"],
    },
  },
];

const WRITE_TOOL_NAMES = new Set(writeTools.map((t) => t.name));

/** Optional array of non-empty strings, or [] when omitted. */
function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim())) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return value as string[];
}

/** Build the endpoints[] block. Refuses an empty target and an unconfirmed "ALL". */
export function buildTargets(args: Record<string, unknown>): AutomationTarget[] {
  const endpoints = stringArray(args.endpoint_ids, "endpoint_ids");
  const groups = stringArray(args.endpoint_group_ids, "endpoint_group_ids");
  if (endpoints.length + groups.length === 0) {
    throw new Error("Provide at least one of endpoint_ids or endpoint_group_ids");
  }
  if (groups.some((g) => g.toUpperCase() === "ALL") && args.confirm_all_endpoints !== true) {
    throw new Error(
      'endpoint_group_ids contains "ALL", which targets every endpoint in the organization. ' +
        "Set confirm_all_endpoints=true to proceed.",
    );
  }
  return [
    ...endpoints.map((id) => ({ id, type: "Endpoint" as const })),
    ...groups.map((id) => ({ id, type: "EndpointGroup" as const })),
  ];
}

/** Required non-empty string argument. */
function requireString(args: Record<string, unknown>, field: string): string {
  const v = args[field];
  if (typeof v !== "string" || !v.trim()) throw new Error(`${field} is required`);
  return v;
}

/** Optional positive integer, or undefined when omitted. */
function optionalPositiveInt(v: unknown, field: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return v;
}

/** Optional non-empty string, or undefined when omitted. */
function optionalString(v: unknown, field: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !v.trim()) throw new Error(`${field} must be a non-empty string`);
  return v;
}

/** retry_minutes as the string Action1 expects, defaulting to 24h. */
function retryMinutes(args: Record<string, unknown>): string {
  return String(optionalPositiveInt(args.retry_minutes, "retry_minutes") ?? 1440);
}

/** Action1 reboot_options block. No reboot unless `reboot` is true. */
function rebootOptions(reboot: boolean, message?: string, timeout?: number, showMessage = true) {
  if (!reboot) return { auto_reboot: "no" };
  return {
    auto_reboot: "yes",
    show_message: showMessage ? "yes" : "no",
    message_text: message ?? DEFAULT_REBOOT_MESSAGE,
    timeout: timeout ?? 240,
  };
}

/** Build the actions[] block for a write tool. Exported for tests. */
export function buildAction(name: string, args: Record<string, unknown>): AutomationAction {
  switch (name) {
    case "action1_run_script": {
      const language = (args.language as string | undefined) ?? "PowerShell";
      if (!["PowerShell", "Command", "Bash"].includes(language)) {
        throw new Error("language must be PowerShell, Command or Bash");
      }
      return {
        name: `Run ${language}`,
        template_id: "run_script",
        params: {
          display_summary: requireString(args, "name"),
          condition_script_text: "",
          condition_script_language: "PowerShell",
          run_script_params: [],
          run_script_text: requireString(args, "script_text"),
          run_script_language: language,
          reboot_exit_codes: "",
          reboot_options: rebootOptions(args.reboot_after === true),
        },
      };
    }
    case "action1_reboot_endpoints":
      return {
        name: "Reboot",
        template_id: "reboot",
        params: {
          display_summary: "Reboot",
          reboot_options: rebootOptions(
            true,
            optionalString(args.message_text, "message_text"),
            optionalPositiveInt(args.timeout_minutes, "timeout_minutes"),
            args.show_message !== false,
          ),
        },
      };
    case "action1_deploy_updates": {
      const packages = args.packages;
      if (!Array.isArray(packages) || packages.length === 0) {
        throw new Error("packages must be a non-empty array of {package_id, version}");
      }
      const mapped = packages.map((p, i) => {
        const pkg = p as Record<string, unknown>;
        if (typeof pkg?.package_id !== "string" || typeof pkg?.version !== "string") {
          throw new Error(`packages[${i}] needs string package_id and version`);
        }
        return { [pkg.package_id]: pkg.version };
      });
      return {
        name: "Deploy Update",
        template_id: "deploy_update",
        params: {
          scope: "Specified",
          display_summary: requireString(args, "name"),
          packages: mapped,
          reboot_options: rebootOptions(args.reboot_after === true),
        },
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** Split Action1's CRLF step descriptions into clean lines. */
function outputLines(description: string | undefined): string[] {
  return (description ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
}

/** Instance status plus one row per endpoint, with step output unless include_output is false. */
async function getResults(args: Record<string, unknown>) {
  const client = getClient();
  const instanceId = requireString(args, "instance_id");
  const orgId = args.organization_id as string | undefined;
  const includeOutput = args.include_output !== false;

  const instance = await client.getAutomationInstance(instanceId, { orgId });
  const page = await client.listAutomationEndpointResults(instanceId, { orgId, limit: 500 });

  // One endpoint at a time: Action1 rate-limits bursts (the client also retries 429s).
  const rows: Array<Record<string, unknown>> = [];
  for (const r of page.items) {
    const row: Record<string, unknown> = {
      endpoint_id: r.id,
      endpoint_name: r.endpoint_name,
      status: r.status,
      percent_completed: r.percent_completed,
      last_update: r.time,
      summary: r.description,
    };
    if (includeOutput) {
      // One endpoint's log failing to load should not hide everyone else's results.
      try {
        const details = await client.getAutomationEndpointDetails(instanceId, r.id, { orgId });
        row.steps = details.items.map((d) => ({
          time: d.time,
          status: d.status,
          action: d.action_name,
          output: outputLines(d.description),
        }));
      } catch (e) {
        row.output_error = e instanceof Error ? e.message : String(e);
      }
    }
    rows.push(row);
  }

  const counts: Record<string, number> = {};
  for (const r of rows) {
    const s = String(r.status ?? "Unknown");
    counts[s] = (counts[s] ?? 0) + 1;
  }

  return {
    instance_id: instance.id,
    name: instance.name,
    status: instance.status,
    percent_completed: instance.percent_completed,
    start_time: instance.start_time,
    counts,
    // Only the first 500 endpoints are fetched; counts cover those rows only.
    truncated: Boolean(page.next_page),
    endpoints: rows,
  };
}

export const automationsHandler: DomainHandler = {
  get tools() {
    return writesEnabled() ? [...writeTools, ...readTools] : readTools;
  },
  async handle(name, args) {
    if (name === "action1_get_automation_results") {
      const results = await getResults(args);
      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
    }
    if (WRITE_TOOL_NAMES.has(name)) {
      if (!writesEnabled()) throw new Error(WRITES_DISABLED_MESSAGE);
      const endpoints = buildTargets(args);
      const action = buildAction(name, args);
      const client = getClient();
      const instance = await client.createAutomationInstance(
        { orgId: args.organization_id as string | undefined },
        {
          name: name === "action1_reboot_endpoints"
            ? (optionalString(args.name, "name") ?? "Reboot")
            : requireString(args, "name"),
          retry_minutes: retryMinutes(args),
          endpoints,
          actions: [action],
        },
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                instance_id: instance.id,
                name: instance.name,
                status: instance.status,
                targets: endpoints.length,
                next: "Call action1_get_automation_results with this instance_id to see per-endpoint results.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }
    throw new Error(`Unknown tool: ${name}`);
  },
};
