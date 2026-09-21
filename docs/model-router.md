# Feishu Pi model routing

This optional router applies only to Pi sessions started by the Feishu bridge. Enable it by creating `~/.pi/agent/feishu/model-router.json`:

```json
{"enabled": true}
```

Requests in a workspace whose path contains a `kdh` segment, requests mentioning `kdh`, and Codex/PR review requests go to `cliproxyapi/gpt-5.6-sol`. Image requests also use Sol when it is available, because the configured DeepSeek 4.1 Flash model accepts text only.

Other requests are scored with Jev through Kaon Router's Decisions API. The router reads the existing Kaon API key from Pi's `models.json`; no second key is required. It sends the current request and a bounded excerpt of recent conversation text. Confident trivial requests use `kaon/aliyunus/deepseek-v4.1-flash`, moderate requests use `cliproxyapi/gpt-5.6-terra`, and complex requests use `cliproxyapi/gpt-5.6-sol`. If Jev cannot make a confident decision or the target model is unavailable, the current model stays in use. A manual `/model` selection other than the default Flash model remains in effect for non-priority requests.

Enabled Feishu sessions disable Pi's same-model auto-retry. If the turn fails, the bridge retries once on DeepSeek 4.1 Flash in the same Pi conversation and Feishu reply card. The existing global `model-failover.ts` chain is excluded from enabled Feishu sessions so it cannot redirect the bot to a different fallback. The routing and fallback code remains inactive when `model-router.json` is absent or disabled.
