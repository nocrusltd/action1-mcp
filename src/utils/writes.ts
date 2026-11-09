/**
 * Write-tool gate.
 *
 * Tools that change endpoints (run a script, reboot, deploy updates) are off
 * unless ACTION1_ENABLE_WRITES is "true" or "1". When off they are not listed
 * and calling them by name is refused, so a read-only install stays read-only.
 */

import { cleanCredential } from "./client.js";

export function writesEnabled(): boolean {
  const raw = cleanCredential(process.env.ACTION1_ENABLE_WRITES)?.toLowerCase();
  return raw === "true" || raw === "1";
}

export const WRITES_DISABLED_MESSAGE =
  "Action1 write tools are disabled. Set ACTION1_ENABLE_WRITES=true to enable " +
  "action1_run_script, action1_reboot_endpoints and action1_deploy_updates.";
