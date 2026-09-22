# Feishu Pi model routing

This optional router applies only to Pi sessions started by the Feishu bridge. Enable it by creating `~/.pi/agent/feishu/model-router.json`:

```json
{"enabled": true}
```

Requests in a workspace whose path contains a `kdh` segment, current user requests mentioning `kdh`, and Codex/PR review requests go to `cliproxyapi/gpt-5.6-sol`. An image request retains a manually selected vision-capable model, or uses Sol when it is available. The configured DeepSeek 4.1 Flash model accepts text only. Mentions inside quoted or unrelated group messages do not trigger the fixed rules.

Other requests are scored with Jev through Kaon Router's Decisions API. The router resolves the existing Kaon credential through Pi's model runtime, including supported environment, command, and stored credentials; no second key is required. Routing runs inside the conversation queue. It sends the current request separately from bounded quoted/group context, attached text, and recent user/assistant history, so a long quote cannot displace the user's request. Confident trivial requests use `kaon/aliyunus/deepseek-v4.1-flash`, moderate requests use `cliproxyapi/gpt-5.6-terra`, complex requests use `cliproxyapi/gpt-5.6-sol`, and extreme requests use `cliproxyapi/gpt-6-astra`. If Jev cannot make a confident decision or the target model is unavailable, the current model stays in use. New manual `/model` selections, including Flash, remain in effect for non-priority requests when the selected model supports the input. Use `/model auto` to resume automatic routing. Legacy Flash selections are treated as automatic defaults. Router logs record the selected model, reason, score, confidence, and decision latency without prompt content or credentials.

Enabled Feishu sessions start with automatic retry disabled. A provider error selects DeepSeek 4.1 Flash and enables one native Pi continuation, preserving the original user request and completed tool results. This avoids inserting a second user prompt or replaying successful tool actions. A second provider error ends the turn; cancellation and tool failures do not trigger model fallback. Hard timeout handling waits for the aborted run to stop before releasing the conversation queue. Both success and failure replace streaming preview text with the authoritative final message, even when it is shorter.

Model choices and retry settings use per-session memory storage, retaining project overrides and trust without modifying global Pi settings. The existing global `model-failover.ts` chain is excluded from enabled Feishu sessions so it cannot redirect the bot to a different fallback. Turn logs include model usage, tool call count, elapsed time, and whether fallback was attempted. The routing and fallback code remains inactive when `model-router.json` is absent or disabled; restart the bridge after changing this switch.
