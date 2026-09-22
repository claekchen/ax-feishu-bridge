import test from "node:test";
import assert from "node:assert/strict";
import { extractTextFromInteractiveCard, extractTextFromMsgType } from "../src/feishu/interactive-card.ts";
import { parseMessageInput, buildPromptWithQuote } from "../src/feishu/messages.ts";

test("extracts header and div/markdown from schema 1.0 card", () => {
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "P1 Alert" },
      subtitle: { tag: "plain_text", content: "prod" },
    },
    elements: [
      { tag: "div", text: { tag: "plain_text", content: "rule: high_cpu" } },
      { tag: "markdown", content: "**traceId**: abc-123" },
      { tag: "note", elements: [{ tag: "plain_text", content: "region=cn-hangzhou" }] },
    ],
  };
  const { text } = extractTextFromInteractiveCard(JSON.stringify(card));
  assert.match(text, /P1 Alert/);
  assert.match(text, /high_cpu/);
  assert.match(text, /abc-123/);
  assert.match(text, /cn-hangzhou/);
});

test("extracts schema 2.0 body.elements", () => {
  const card = {
    schema: "2.0",
    header: { title: { tag: "plain_text", content: "Deploy failed" } },
    body: {
      elements: [{ tag: "markdown", content: "service: payments\nerror: timeout" }],
    },
  };
  const { text } = extractTextFromInteractiveCard(JSON.stringify(card));
  assert.match(text, /Deploy failed/);
  assert.match(text, /payments/);
});

test("parseMessageInput handles interactive", () => {
  const content = JSON.stringify({
    header: { title: { tag: "plain_text", content: "Card Title" } },
    elements: [{ tag: "div", text: { tag: "lark_md", content: "body line" } }],
  });
  const parsed = parseMessageInput(
    {
      messageId: "m1",
      chatId: "c1",
      chatType: "group",
      senderOpenId: "u1",
      msgType: "interactive",
      content,
    },
    undefined,
    { parseInteractiveCards: true },
  );
  assert.match(parsed.text, /Card Title/);
  assert.match(parsed.text, /body line/);
  assert.equal(parsed.source, "interactive");
});

test("buildPromptWithQuote merges parent card", () => {
  const prompt = buildPromptWithQuote("help investigate", {
    msgType: "interactive",
    text: "P1 Alert\ntraceId: x",
  });
  assert.match(prompt, /Quoted message/);
  assert.match(prompt, /traceId: x/);
  assert.match(prompt, /help investigate/);
});

test("extractTextFromMsgType text strips bot mention", () => {
  const r = extractTextFromMsgType("text", JSON.stringify({ text: "@ou_bot please check" }), "ou_bot");
  assert.equal(r.text, "please check");
});

test("preserves button and inline link targets without callback payloads", () => {
  const card = {
    header: { title: { tag: "plain_text", content: "Review request" } },
    elements: [
      { tag: "action", actions: [{
        tag: "button", text: { tag: "plain_text", content: "Open PR" },
        url: "https://github.com/acme/repo/pull/42",
        value: { secret: "callback-secret", url: "https://internal.invalid/callback-only" },
      }] },
      { tag: "column_set", columns: [{ tag: "column", elements: [{
        tag: "div", text: { tag: "plain_text", content: "Deployment details" },
        extra: {
          tag: "button", text: { tag: "plain_text", content: "Open deployment" },
          behaviors: [
            { type: "callback", value: { text: "hidden action data" } },
            { type: "open_url", default_url: "https://deploy.example.com/build/7" },
          ],
        },
      }] }] },
      { tag: "a", text: "Runbook", href: "https://docs.example.com/runbook" },
    ],
  };
  const { text } = extractTextFromInteractiveCard(JSON.stringify(card));
  assert.match(text, /Open PR.*https:\/\/github.com\/acme\/repo\/pull\/42/);
  assert.match(text, /Deployment details/);
  assert.match(text, /Open deployment.*https:\/\/deploy.example.com\/build\/7/);
  assert.match(text, /Runbook.*https:\/\/docs.example.com\/runbook/);
  assert.doesNotMatch(text, /callback-secret|callback-only|hidden action data/);
});

test("nested raw CardKit wrappers retain inherited variables and property-based display nodes", () => {
  const card = {
    type: "interactive",
    variables: { title: "Incident 17", doc: "https://docs.example.com/incident/17" },
    data: {
      card: {
        type: "card_json",
        data: JSON.stringify({ json_card: JSON.stringify({
          header: { property: { title: { tag: "plain_text", property: { content: "${title}" } } } },
          body: { property: { elements: [{ tag: "markdown", property: { elements: [
            { tag: "plain_text", property: { content: "Investigate this incident" } },
            { tag: "a", property: { text: "Source", href: "{{ doc }}" } },
          ] } }] } },
        }) }),
      },
    },
  };
  const { text } = extractTextFromInteractiveCard(JSON.stringify(card));
  assert.match(text, /Incident 17/);
  assert.match(text, /Investigate this incident/);
  assert.match(text, /Source.*https:\/\/docs.example.com\/incident\/17/);
  assert.doesNotMatch(text, /json_card|template_variable|card_json/);
});

test("selects a single localized card body and title without repeating translations", () => {
  const card = {
    header: { title: { tag: "plain_text", content: "Default title", i18n: { en_us: "English title", zh_cn: "中文标题" } } },
    elements: [{ tag: "markdown", content: "Default body" }],
    i18n_elements: {
      en_us: [{ tag: "markdown", content: "English body" }],
      zh_cn: [
        { tag: "markdown", content: "中文正文" },
        { tag: "plain_text", property: { i18n_content: { zh_cn: "本地化补充", en_us: "Other language" } } },
      ],
    },
  };
  const { text } = extractTextFromInteractiveCard(JSON.stringify(card));
  assert.equal(text, "中文标题\n中文正文\n本地化补充");
});

test("extracts card links and markdown href mappings with deduplicated attachments", () => {
  const image = { tag: "img", img_key: "img-key", alt: { tag: "plain_text", content: "Screenshot" } };
  const card = {
    card_link: { url: "https://example.com/card", pc_url: "https://example.com/card" },
    elements: [
      { tag: "markdown", content: "[View details]($url)", href: { url: { url: "https://example.com/details" } } },
      image, image,
      { tag: "file", file_key: "file-key", file_name: "report.pdf" },
      { tag: "file", property: { file_key: "file-key", file_name: "report.pdf" } },
    ],
  };
  const result = extractTextFromInteractiveCard(JSON.stringify(card));
  assert.match(result.text, /https:\/\/example.com\/details/);
  assert.equal(result.text.split("https://example.com/card").length - 1, 1);
  assert.deepEqual(result.attachments, [
    { kind: "image", fileKey: "img-key" }, { kind: "file", fileKey: "file-key", fileName: "report.pdf" },
  ]);
});

test("template references expose named visible fields without dumping arbitrary variables", () => {
  const card = { type: "template", data: { template_id: "template-123", template_variable: {
    title: "Build report", content: "Two tests failed", url: "https://ci.example.com/build/9",
    secret: "private-token", callback: { text: "callback-payload", value: 123 },
  } } };
  const { text } = extractTextFromInteractiveCard(JSON.stringify(card));
  assert.match(text, /Build report/);
  assert.match(text, /Two tests failed/);
  assert.match(text, /https:\/\/ci.example.com\/build\/9/);
  assert.doesNotMatch(text, /private-token|callback-payload|template-123/);
  const opaque = extractTextFromInteractiveCard(JSON.stringify({ type: "template", data: {
    template_id: "private-id", template_variable: { secret: "do-not-print" },
  } }));
  assert.equal(opaque.text, "[Interactive Card]");
});

test("direct and localized posts preserve title, paragraphs, URLs and unique attachments", () => {
  const post = { title: "Review context", content: [
    [{ tag: "text", text: "Please inspect " }, { tag: "a", text: "this PR", href: "https://github.com/acme/repo/pull/42" }],
    [{ tag: "text", text: "Expected behavior: retry once." }],
    [{ tag: "img", image_key: "img-key" }, { tag: "img", image_key: "img-key" },
      { tag: "file", file_key: "file-key", file_name: "trace.txt" }],
  ] };
  for (const content of [post, { zh_cn: post }, { post: { zh_cn: post } }, { en_us: post }, { metadata: "ignored", fr_fr: post }]) {
    const result = extractTextFromMsgType("post", JSON.stringify(content));
    assert.equal(result.text, "Review context\nPlease inspect this PR https://github.com/acme/repo/pull/42\nExpected behavior: retry once.");
    assert.deepEqual(result.attachments, [
      { kind: "image", fileKey: "img-key" }, { kind: "file", fileKey: "file-key", fileName: "trace.txt" },
    ]);
  }
});

test("post paragraphs retain intentional repetition and nested list line breaks", () => {
  const result = extractTextFromMsgType("post", JSON.stringify({ title: "Checks", content: [
    [{ tag: "text", text: "Repeat" }], [{ tag: "text", text: "Repeat" }],
    [{ tag: "ul", content: [
      { tag: "li", content: [{ tag: "text", text: "First" }] },
      { tag: "li", content: [{ tag: "a", text: "Second", href: "https://example.com/second" }] },
    ] }],
  ] }));
  assert.equal(result.text, "Checks\nRepeat\nRepeat\nFirst\nSecond https://example.com/second");
});

test("bounded extraction handles excessive nesting, huge text and opaque callback JSON", () => {
  let nested: unknown = { tag: "markdown", content: "Too deeply nested" };
  for (let index = 0; index < 30; index++) nested = { body: nested };
  const result = extractTextFromInteractiveCard(JSON.stringify({
    header: { title: { content: "Visible title" } }, body: nested,
    elements: [{ tag: "markdown", content: "x".repeat(20000) }],
  }), { maxChars: 200 });
  assert.ok(result.text.length <= 200);
  assert.match(result.text, /Visible title/);
  assert.doesNotMatch(result.text, /Too deeply nested/);
  const opaque = extractTextFromInteractiveCard(JSON.stringify({ action: { value: { secret: "opaque-secret" } } }));
  assert.equal(opaque.text, "[Interactive Card]");
  assert.equal(extractTextFromInteractiveCard('{"action":{"secret":"invalid-json"').text, "[Interactive Card]");
});

test("raw CardKit rich text keeps code spans, list entries and header badges", () => {
  const result = extractTextFromInteractiveCard(JSON.stringify({
    json_attachment: { images: { "17": { origin_key: "img-unused-metadata" } } },
    json_card: JSON.stringify({
      header: { tag: "card_header", property: {
        title: { tag: "plain_text", property: { content: "Reply" } },
        textTagList: [{ tag: "text_tag", property: { text: { tag: "plain_text", property: { content: "Review" } } } }],
      } },
      body: { tag: "body", property: { elements: [{ tag: "markdown", property: { elements: [
        { tag: "plain_text", property: { content: "CI " } },
        { tag: "code_span", property: { content: "test" } },
        { tag: "list", property: { items: [{ type: "ul", level: 0, elements: [
          { tag: "plain_text", property: { content: "Approved " } },
          { tag: "code_span", property: { content: "abc1234" } },
        ] }] } },
      ] } }] } },
    }),
  }));
  for (const visible of ["Reply", "Review", "CI", "test", "Approved", "abc1234"]) assert.ok(result.text.includes(visible));
  assert.deepEqual(result.attachments, []);
  assert.doesNotMatch(result.text, /img-unused-metadata|json_attachment/);
});

test("schema 1 raw div text objects preserve nested display content", () => {
  const result = extractTextFromInteractiveCard(JSON.stringify({ elements: [{
    tag: "div", property: { text: { tag: "markdown", property: { elements: [
      { tag: "plain_text", property: { content: "Check the linked change" } },
      { tag: "br" },
      { tag: "a", property: { text: "PR", href: "https://github.com/acme/repo/pull/17" } },
    ] } } },
  }] }));
  assert.match(result.text, /Check the linked change/);
  assert.match(result.text, /PR.*https:\/\/github.com\/acme\/repo\/pull\/17/);
});

test("raw image metadata resolves only images referenced by visible nodes", () => {
  const result = extractTextFromInteractiveCard(JSON.stringify({
    json_attachment: JSON.stringify({ images: {
      "17": { origin_key: "img-visible" }, "18": { origin_key: "img-unused" },
    } }),
    json_card: JSON.stringify({ body: { elements: [
      { tag: "image", property: { image_id: "17" } },
      { tag: "img", property: { img_key: "17" } },
      { tag: "img", img_key: "img-direct" },
    ] } }),
  }));
  assert.deepEqual(result.attachments, [
    { kind: "image", fileKey: "img-visible" }, { kind: "image", fileKey: "img-direct" },
  ]);
});
