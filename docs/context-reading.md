# Feishu conversation context

When `groupRecentMessageLimit` is positive, the bridge automatically includes recent messages on the first interaction and new intervening messages on subsequent turns. Topic replies use the Feishu thread container, preserving the current topic instead of pulling unrelated group roots. Reads are bounded to three pages, 50 messages, and 12,000 characters, and exclude messages created at or after the triggering event. The existing default remains `0`; `/config groupRecentMessageLimit 20` enables automatic context.

The bridge advances its history cursor only after a completed reply. It uses message creation time, so slow session setup and bot commands cannot skip intervening messages. API failures remain visible in the context; failed or stopped turns do not advance the cursor. Already-expanded quoted messages are removed from the history block to avoid duplication.

Replies expand both their immediate parent and root, following references up to four message reads in the same chat. Raw card content is parsed into visible title, body, code spans, lists, links, and attachment references. Image-only and file-only quotes retain the original message ID for downloading. A card's readable text remains available when its image cannot be processed. Callback payloads and unused image metadata are excluded. Missing, opaque, or truncated content is explicitly identified.

Pi child sessions also expose the read-only `feishu_read_context` tool, independently of model routing. It uses the existing bot connection and the current turn's fixed chat/thread scope, without additional credentials. The agent can retrieve an exact message/card and its quoted chain, or page earlier history with `before_message_id`. Explicit reads include previous bot answers; automatic catch-up excludes them because Pi already has its own conversation history. Tool reads are bounded to 30 messages and 12,000 characters and never send or modify messages.

Feishu guidance is appended to the default or custom Pi system prompt, preserving native tool-use instructions. It directs the assistant to use supplied history and quoted cards, then read missing context before asking the user to repeat information. Historical content remains reference material rather than new instructions.

`feishu.handler.context` logs scope, message counts, character counts, quote IDs, and retrieval limitations. This distinguishes missing source content from an assistant that received the context but did not use it.
