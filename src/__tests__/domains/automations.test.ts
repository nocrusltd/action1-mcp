import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { automationsHandler, buildAction, buildTargets } from "../../domains/automations.js";
import * as clientModule from "../../utils/client.js";

const WRITE_TOOLS = ["action1_run_script", "action1_reboot_endpoints", "action1_deploy_updates"];
const original = process.env.ACTION1_ENABLE_WRITES;

function setWrites(value: string | undefined): void {
  if (value === undefined) delete process.env.ACTION1_ENABLE_WRITES;
  else process.env.ACTION1_ENABLE_WRITES = value;
}

describe("automations domain", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => setWrites(original));

  describe("write gate", () => {
    it("lists only the read tool when writes are off (default)", () => {
      setWrites(undefined);
      expect(automationsHandler.tools.map((t) => t.name)).toEqual(["action1_get_automation_results"]);
    });

    it.each(["false", "0", "", "${user_config.action1_enable_writes}"])(
      "treats %j as off",
      (value) => {
        setWrites(value);
        expect(automationsHandler.tools.map((t) => t.name)).not.toContain("action1_run_script");
      },
    );

    it.each(["true", "TRUE", "1"])("lists write tools when ACTION1_ENABLE_WRITES=%s", (value) => {
      setWrites(value);
      expect(automationsHandler.tools.map((t) => t.name)).toEqual([
        ...WRITE_TOOLS,
        "action1_get_automation_results",
      ]);
    });

    it.each(WRITE_TOOLS)("refuses %s by name when writes are off, without calling the API", async (tool) => {
      setWrites(undefined);
      const createAutomationInstance = vi.fn();
      vi.spyOn(clientModule, "getClient").mockReturnValue({ createAutomationInstance } as never);

      await expect(
        automationsHandler.handle(tool, {
          name: "x",
          script_text: "x",
          endpoint_ids: ["e1"],
          packages: [{ package_id: "p", version: "1" }],
        }),
      ).rejects.toThrow(/write tools are disabled/);
      expect(createAutomationInstance).not.toHaveBeenCalled();
    });

    it("marks write tools destructive", () => {
      setWrites("true");
      for (const t of automationsHandler.tools.filter((t) => WRITE_TOOLS.includes(t.name))) {
        expect(t.annotations?.destructiveHint, t.name).toBe(true);
        expect(t.annotations?.readOnlyHint, t.name).toBe(false);
      }
    });
  });

  describe("buildTargets", () => {
    it("maps endpoint and group ids", () => {
      expect(buildTargets({ endpoint_ids: ["e1"], endpoint_group_ids: ["g1"] })).toEqual([
        { id: "e1", type: "Endpoint" },
        { id: "g1", type: "EndpointGroup" },
      ]);
    });

    it("refuses an empty target", () => {
      expect(() => buildTargets({})).toThrow(/at least one/);
      expect(() => buildTargets({ endpoint_ids: [] })).toThrow(/at least one/);
    });

    it("refuses the ALL group unless confirmed", () => {
      expect(() => buildTargets({ endpoint_group_ids: ["ALL"] })).toThrow(/confirm_all_endpoints/);
      expect(() => buildTargets({ endpoint_group_ids: ["all"] })).toThrow(/confirm_all_endpoints/);
      expect(buildTargets({ endpoint_group_ids: ["ALL"], confirm_all_endpoints: true })).toEqual([
        { id: "ALL", type: "EndpointGroup" },
      ]);
    });

    it("rejects non-string ids", () => {
      expect(() => buildTargets({ endpoint_ids: [1] })).toThrow(/non-empty strings/);
      expect(() => buildTargets({ endpoint_ids: "e1" })).toThrow(/non-empty strings/);
    });
  });

  describe("buildAction", () => {
    it("builds an inline run_script action that does not reboot by default", () => {
      const a = buildAction("action1_run_script", { name: "Fix", script_text: "Write-Output hi" });
      expect(a).toEqual({
        name: "Run PowerShell",
        template_id: "run_script",
        params: {
          display_summary: "Fix",
          condition_script_text: "",
          condition_script_language: "PowerShell",
          run_script_params: [],
          run_script_text: "Write-Output hi",
          run_script_language: "PowerShell",
          reboot_exit_codes: "",
          reboot_options: { auto_reboot: "no" },
        },
      });
    });

    it("rejects an unknown script language", () => {
      expect(() =>
        buildAction("action1_run_script", { name: "x", script_text: "x", language: "Python" }),
      ).toThrow(/language/);
    });

    it("builds a reboot action with a user warning by default", () => {
      const a = buildAction("action1_reboot_endpoints", {});
      expect(a.template_id).toBe("reboot");
      expect(a.params.reboot_options).toMatchObject({ auto_reboot: "yes", show_message: "yes", timeout: 240 });
    });

    it("builds a Specified deploy_update action from package/version pairs", () => {
      const a = buildAction("action1_deploy_updates", {
        name: "Chrome",
        packages: [{ package_id: "Google_Chrome_builtin", version: "131.0" }],
      });
      expect(a).toEqual({
        name: "Deploy Update",
        template_id: "deploy_update",
        params: {
          scope: "Specified",
          display_summary: "Chrome",
          packages: [{ Google_Chrome_builtin: "131.0" }],
          reboot_options: { auto_reboot: "no" },
        },
      });
    });

    it("rejects malformed packages", () => {
      expect(() => buildAction("action1_deploy_updates", { name: "x", packages: [] })).toThrow(/non-empty/);
      expect(() =>
        buildAction("action1_deploy_updates", { name: "x", packages: [{ package_id: "p" }] }),
      ).toThrow(/packages\[0\]/);
    });
  });

  describe("action1_run_script", () => {
    it("posts one instance and returns its id", async () => {
      setWrites("true");
      const createAutomationInstance = vi.fn().mockResolvedValue({ id: "inst-1", name: "Fix", status: "Running" });
      vi.spyOn(clientModule, "getClient").mockReturnValue({ createAutomationInstance } as never);

      const res = await automationsHandler.handle("action1_run_script", {
        organization_id: "org-1",
        name: "Fix",
        script_text: "exit 0",
        endpoint_ids: ["e1", "e2"],
        retry_minutes: 60,
      });

      expect(createAutomationInstance).toHaveBeenCalledTimes(1);
      const [scope, body] = createAutomationInstance.mock.calls[0];
      expect(scope).toEqual({ orgId: "org-1" });
      expect(body.name).toBe("Fix");
      expect(body.retry_minutes).toBe("60");
      expect(body.endpoints).toHaveLength(2);
      expect(body.actions[0].template_id).toBe("run_script");
      expect(JSON.parse(res.content[0].text)).toMatchObject({ instance_id: "inst-1", targets: 2 });
    });

    it("rejects a bad retry_minutes before calling the API", async () => {
      setWrites("true");
      const createAutomationInstance = vi.fn();
      vi.spyOn(clientModule, "getClient").mockReturnValue({ createAutomationInstance } as never);
      await expect(
        automationsHandler.handle("action1_run_script", {
          name: "x",
          script_text: "x",
          endpoint_ids: ["e1"],
          retry_minutes: 0,
        }),
      ).rejects.toThrow(/retry_minutes/);
      expect(createAutomationInstance).not.toHaveBeenCalled();
    });
  });

  describe("action1_get_automation_results", () => {
    it("is available with writes off and returns per-endpoint output lines", async () => {
      setWrites(undefined);
      const client = {
        getAutomationInstance: vi.fn().mockResolvedValue({ id: "i", name: "n", status: "Running", percent_completed: "50" }),
        listAutomationEndpointResults: vi.fn().mockResolvedValue({
          items: [
            { id: "e1", endpoint_name: "PC-1", status: "Success", description: "done" },
            { id: "e2", endpoint_name: "PC-2", status: "Error", description: "Script completed with error: 1" },
          ],
        }),
        getAutomationEndpointDetails: vi.fn().mockImplementation(async (_i: string, eid: string) => ({
          items: [{ id: "d", status: "Success", action_name: "Run PowerShell", description: `OK: ${eid}\r\nDONE\r\n` }],
        })),
      };
      vi.spyOn(clientModule, "getClient").mockReturnValue(client as never);

      const res = await automationsHandler.handle("action1_get_automation_results", { instance_id: "i" });
      const body = JSON.parse(res.content[0].text);

      expect(body.counts).toEqual({ Success: 1, Error: 1 });
      expect(body.endpoints[0].steps[0].output).toEqual(["OK: e1", "DONE"]);
      expect(client.getAutomationEndpointDetails).toHaveBeenCalledTimes(2);
    });

    it("skips the per-endpoint calls when include_output is false", async () => {
      const client = {
        getAutomationInstance: vi.fn().mockResolvedValue({ id: "i" }),
        listAutomationEndpointResults: vi.fn().mockResolvedValue({ items: [{ id: "e1" }] }),
        getAutomationEndpointDetails: vi.fn(),
      };
      vi.spyOn(clientModule, "getClient").mockReturnValue(client as never);
      await automationsHandler.handle("action1_get_automation_results", { instance_id: "i", include_output: false });
      expect(client.getAutomationEndpointDetails).not.toHaveBeenCalled();
    });
  });
});
