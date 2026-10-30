// STOP, START, "delete my data" and admin commands (E4 design L0). The database does
// the work (stop_user and friends in 0006), so a STOP also holds against a turn that is
// already running: no prompt opens, no consent is stored and no call is reserved until START.
import type { User } from "../store.ts";
import { type AdminStore, runAdmin } from "./admin.ts";
import type { Route } from "./gate.ts";
import { type PromptDeps, sendTemplate } from "./turn.ts";

export type CommandDeps = PromptDeps & {
  // Admin commands (admin.ts); without it they say they aren't available.
  admin?: AdminStore;
  trace?: (event: string, data: unknown) => void;
};

export async function runCommand(
  deps: CommandDeps,
  user: User,
  route: Extract<Route, { kind: "command" }>,
): Promise<void> {
  const { store } = deps;
  switch (route.command) {
    case "stop": {
      // Ends every request not yet calling. A call already under way can't be hung up;
      // the reply says so, and nothing follows it.
      const res = await store.stopUser(user.id);
      deps.trace?.("stop", res);
      return sendTemplate(deps, user, res.in_flight ? "stopped_in_flight" : "stopped");
    }
    case "delete_data": {
      // Stops, and records the request for the deletion job (E7, DPDP).
      const res = await store.requestDeletion(user.id);
      deps.trace?.("delete_requested", res);
      return sendTemplate(deps, user, "delete_requested");
    }
    case "start": {
      const res = await store.resumeUser(user.id);
      deps.trace?.("start", res);
      return sendTemplate(deps, user, "started");
    }
    case "admin": {
      if (!deps.admin) return sendTemplate(deps, user, "admin_not_built");
      const body = await runAdmin(deps.admin, route.text, user.waId);
      deps.trace?.("admin", { command: route.text, reply: body });
      await deps.send(user, { kind: "text", body });
      return;
    }
  }
}
