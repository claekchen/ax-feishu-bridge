# Feishu Pi model routing

This optional router applies only to Pi sessions started by the Feishu bridge. Enable it by creating `~/.pi/agent/feishu/model-router.json`:

```json
{"enabled": true}
```

When this router is enabled, Jev classifies each new text request and routes trivial work to `cliproxyapi/gpt-6-luna`, moderate or complex work to `cliproxyapi/gpt-6-sol`, and extreme work to `cliproxyapi/gpt-6-astra`. KDH, Codex review, and image requests use Sol. If Jev is unavailable or returns a low-confidence result, the router uses the session's selected model or Luna. A provider failure retries once on `kaon/aliyunus/deepseek-v4.1-flash`. The bot's `/model` list and manual selections are restricted to Luna, Sol, Astra, and DeepSeek Flash; saved selections outside this set are ignored. `/model auto` resumes automatic difficulty routing. Mentions inside quoted or unrelated group messages do not affect model selection.

Standalone continuations reuse the actual model from the preceding successful turn for up to 30 minutes only when it is in the allowed list. A successful Flash fallback may handle the next bare continuation. The cache clears on failed or stopped turns, session/workspace changes, external session reloads, and model selection commands.

Enabled Feishu sessions start with automatic retry disabled. A provider error selects DeepSeek 4.1 Flash and enables one native Pi continuation, preserving the original user request and completed tool results. This avoids inserting a second user prompt or replaying successful tool actions. A second provider error ends the turn; cancellation and tool failures do not trigger model fallback. Hard timeout handling waits for the aborted run to stop before releasing the conversation queue. Both success and failure replace streaming preview text with the authoritative final message, even when it is shorter.

Model choices and retry settings use per-session memory storage, retaining project overrides and trust without modifying global Pi settings. The existing global `model-failover.ts` chain is excluded from enabled Feishu sessions so it cannot redirect the bot to a different fallback. Turn logs include model usage, tool call count, elapsed time, and whether fallback was attempted. The routing and fallback code remains inactive when `model-router.json` is absent or disabled; restart the bridge after changing this switch.
