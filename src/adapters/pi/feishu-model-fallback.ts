import type { ExtensionFactory, SettingsManager } from "@earendil-works/pi-coding-agent";
import { FLASH_MODEL } from "./feishu-model-routing.ts";

export type FallbackRun = { stopped: boolean; fallbackAttempted?: boolean };

/** Switch before Pi's native retry so it resumes after completed tool results. */
export function createFlashFallbackExtension(options: {
  settings: SettingsManager;
  getRun: () => FallbackRun | undefined;
  onFallback: (from: string, error: string) => void;
}): ExtensionFactory {
  return (pi) => {
    pi.on("message_end", async (event, ctx) => {
      if (event.message.role !== "assistant") return;
      const run = options.getRun();
      if (!run || run.stopped) return;
      options.settings.setRetryEnabled(false);
      if (event.message.stopReason !== "error" || run.fallbackAttempted) return;

      const target = ctx.modelRegistry.find(FLASH_MODEL.provider, FLASH_MODEL.id);
      if (!target || !ctx.modelRegistry.hasConfiguredAuth(target)) return;
      const from = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
      run.fallbackAttempted = true;
      if (!await pi.setModel(target) || run.stopped) return;
      options.onFallback(from, event.message.errorMessage ?? "Unknown model error");
      options.settings.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 500 } });
      return {
        message: {
          ...event.message,
          errorMessage: "provider returned error: Feishu Flash fallback requested",
        },
      };
    });
  };
}
