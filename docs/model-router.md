# Feishu Pi model routing

This optional router applies only to Pi sessions started by the Feishu bridge. Enable it by creating `~/.pi/agent/feishu/model-router.json`:

```json
{"enabled": true}
```

When this budget-limited router is enabled, new turns use only `cliproxyapi/gpt-6-luna`; a provider failure retries once on `kaon/aliyunus/deepseek-v4.1-flash`. The same Luna route applies to KDH, Codex review, and image requests. The bot's `/model` list and manual selections are restricted to those two models, so saved selections for retired models are ignored. Jev difficulty calls are paused because every task uses Luna; this also avoids spending on a classifier call that cannot change the model. `/model auto` resumes the Luna route. Mentions inside quoted or unrelated group messages do not affect model selection.

Standalone continuations reuse the actual model from the preceding successful turn for up to 30 minutes only when it is in the allowed list. A successful Flash fallback may handle the next bare continuation. The cache clears on failed or stopped turns, session/workspace changes, external session reloads, and model selection commands.

Enabled Feishu sessions start with automatic retry disabled. A provider error selects DeepSeek 4.1 Flash and enables one native Pi continuation, preserving the original user request and completed tool results. This avoids inserting a second user prompt or replaying successful tool actions. A second provider error ends the turn; cancellation and tool failures do not trigger model fallback. Hard timeout handling waits for the aborted run to stop before releasing the conversation queue. Both success and failure replace streaming preview text with the authoritative final message, even when it is shorter.

Model choices and retry settings use per-session memory storage, retaining project overrides and trust without modifying global Pi settings. The existing global `model-failover.ts` chain is excluded from enabled Feishu sessions so it cannot redirect the bot to a different fallback. Turn logs include model usage, tool call count, elapsed time, and whether fallback was attempted. The routing and fallback code remains inactive when `model-router.json` is absent or disabled; restart the bridge after changing this switch.
