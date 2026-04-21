import type { HookAction, HookConfig, HookTrigger, MemoryMdSettings, SyncResult } from "./types.js";

export const DEFAULT_HOOKS: Required<HookConfig> = {
  sessionStart: ["pull"],
  sessionEnd: [],
};

function isHookAction(value: unknown): value is HookAction {
  return typeof value === "string" && value.trim().length > 0;
}

export function normalizeHooks(hooks: unknown): HookConfig {
  if (!hooks || typeof hooks !== "object") {
    return {
      sessionStart: [...DEFAULT_HOOKS.sessionStart],
      sessionEnd: [...DEFAULT_HOOKS.sessionEnd],
    };
  }

  if ("onSessionStart" in hooks) {
    const legacyHooks = hooks as { onSessionStart?: boolean };

    return {
      sessionStart: legacyHooks.onSessionStart === false ? [] : [...DEFAULT_HOOKS.sessionStart],
      sessionEnd: [],
    };
  }

  const config = hooks as Record<HookTrigger, unknown>;

  return {
    sessionStart: Array.isArray(config.sessionStart)
      ? config.sessionStart.filter(isHookAction)
      : [...DEFAULT_HOOKS.sessionStart],
    sessionEnd: Array.isArray(config.sessionEnd)
      ? config.sessionEnd.filter(isHookAction)
      : [...DEFAULT_HOOKS.sessionEnd],
  };
}

export function getHookActions(settings: MemoryMdSettings, trigger: HookTrigger): HookAction[] {
  return settings.hooks?.[trigger] ?? DEFAULT_HOOKS[trigger];
}

export async function runHookTrigger(
  settings: MemoryMdSettings,
  trigger: HookTrigger,
  runHookAction: (action: HookAction) => Promise<SyncResult>,
): Promise<Array<{ action: HookAction; result: SyncResult }>> {
  const actions = getHookActions(settings, trigger);
  const results: Array<{ action: HookAction; result: SyncResult }> = [];

  for (const action of actions) {
    results.push({ action, result: await runHookAction(action) });
  }

  return results;
}
