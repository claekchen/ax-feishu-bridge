import { SettingsManager } from "@earendil-works/pi-coding-agent";

/** Keep per-conversation model choices and retry policy out of shared Pi settings. */
export function createFeishuSessionSettings(
  cwd: string,
  agentDir: string,
  routingEnabled: boolean,
  options: Parameters<typeof SettingsManager.create>[2] = {},
): SettingsManager {
  const source = SettingsManager.create(cwd, agentDir, options);
  const globalSettings = source.getGlobalSettings();
  const projectSettings = source.getProjectSettings();

  if (routingEnabled) {
    globalSettings.retry = {
      ...globalSettings.retry,
      enabled: false,
      maxRetries: 1,
      baseDelayMs: 500,
    };
    // Let the bridge enable one native continuation after selecting its fallback.
    // Project values must not shadow that session-local toggle.
    if (projectSettings.retry) {
      delete projectSettings.retry.enabled;
      delete projectSettings.retry.maxRetries;
      delete projectSettings.retry.baseDelayMs;
    }
  }

  const contents = {
    global: JSON.stringify(globalSettings),
    project: JSON.stringify(projectSettings),
  };
  return SettingsManager.fromStorage({
    withLock(scope, update) {
      const next = update(contents[scope]);
      if (next !== undefined) contents[scope] = next;
    },
  }, { projectTrusted: source.isProjectTrusted() });
}
