import type { FeishuAttachment } from "./types.ts";

const INTERACTIVE_CARD_FALLBACK = "[Interactive Card]";
const MAX_DEPTH = 16;
const MAX_NODES = 2000;
const MAX_ATTACHMENTS = 64;
const MAX_JSON_CHARS = 2_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function preferredLocale(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  for (const key of [...new Set(["zh_cn", "zh-CN", "en_us", "en-US", ...Object.keys(value)])]) {
    const candidate = value[key];
    if (candidate != null && candidate !== "" && (!Array.isArray(candidate) || candidate.length)) return candidate;
  }
  return undefined;
}

function withProperty(value: Record<string, unknown>): Record<string, unknown> {
  return isRecord(value.property) ? { ...value, ...value.property } : value;
}

function templateVariables(node: Record<string, unknown>, inherited: Map<string, string>): Map<string, string> {
  const variables = new Map(inherited);
  for (const candidate of [node.variables, node.template_variable, node.template_variables]) {
    if (!isRecord(candidate)) continue;
    for (const [key, value] of Object.entries(candidate).slice(0, 200)) {
      if (typeof value === "string") variables.set(key, value.slice(0, 64000));
      else if (typeof value === "number" || typeof value === "boolean") variables.set(key, String(value));
    }
  }
  return variables;
}

function applyVariables(text: string, variables: Map<string, string>): string {
  let expandedChars = 0;
  return text.replace(/\$\{([A-Za-z0-9_.-]+)\}|\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g,
    (match, first, second) => {
      const replacement = (variables.get(first ?? second) ?? match).slice(0, Math.max(0, 64000 - expandedChars));
      expandedChars += replacement.length;
      return replacement;
    }).slice(0, 64000);
}

function visibleText(value: unknown, variables: Map<string, string>, depth = 0): string {
  if (depth > 4) return "";
  if (typeof value === "string") return applyVariables(value.slice(0, 64000), variables);
  if (!isRecord(value)) return "";
  const node = withProperty(value);
  const localized = preferredLocale(node.i18n ?? node.i18n_content ?? node.i18n_text);
  if (localized !== undefined) return visibleText(localized, variables, depth + 1);
  for (const candidate of [node.content, node.text]) {
    if (typeof candidate === "string" || isRecord(candidate)) {
      const text = visibleText(candidate, variables, depth + 1);
      if (text) return text;
    }
  }
  return "";
}

function decodeCard(value: unknown): unknown {
  if (typeof value !== "string" || value.length > MAX_JSON_CHARS) return value;
  try { return JSON.parse(value); } catch { return undefined; }
}

function visibleUrls(node: Record<string, unknown>, variables: Map<string, string>): string[] {
  const urls = new Set<string>();
  function add(value: unknown) {
    if (typeof value !== "string") return;
    const url = applyVariables(value.slice(0, 8000), variables).trim();
    if (/^(?:https?:\/\/|mailto:|tel:|(?:lark|feishu):\/\/)/i.test(url)) urls.add(url);
  }
  function addTarget(value: unknown) {
    if (typeof value === "string") return add(value);
    if (!isRecord(value)) return;
    const target = withProperty(value);
    for (const key of ["url", "default_url", "pc_url", "ios_url", "android_url"]) add(target[key]);
  }
  for (const key of ["url", "href", "multi_url", "multi_utl", "card_link"]) addTarget(node[key]);
  if (isRecord(node.href)) {
    for (const target of Object.values(node.href).slice(0, 50)) addTarget(target);
  }
  if (Array.isArray(node.behaviors)) {
    for (const behavior of node.behaviors.slice(0, 20)) {
      if (isRecord(behavior) && (behavior.type === "open_url" || behavior.type === "open_link")) addTarget(behavior);
    }
  }
  return [...urls];
}

function textWithUrls(label: string, urls: string[]): string {
  const missing = urls.filter((url) => !label.includes(url));
  return [label, ...missing].filter(Boolean).join(" ");
}

type ExtractionState = {
  parts: string[];
  seenText: Set<string>;
  attachments: FeishuAttachment[];
  seenAttachments: Set<string>;
  imageReferences: Map<string, string>;
  nodes: number;
  chars: number;
  maxChars: number;
  truncated: boolean;
};

function createState(attachments: FeishuAttachment[], maxChars = 12000): ExtractionState {
  return {
    parts: [], seenText: new Set(), attachments,
    seenAttachments: new Set(attachments.map((item) => `${item.kind}:${item.fileKey}`)),
    imageReferences: new Map(),
    nodes: 0, chars: 0, maxChars, truncated: false,
  };
}

function addText(state: ExtractionState, value: string, deduplicate = true) {
  const text = value.trim();
  if (!text || (deduplicate && state.seenText.has(text))) return;
  const remaining = state.maxChars - state.chars - (state.parts.length ? 1 : 0);
  if (remaining <= 0) { state.truncated = true; return; }
  state.seenText.add(text);
  state.parts.push(text.slice(0, remaining));
  state.chars += Math.min(text.length, remaining) + (state.parts.length > 1 ? 1 : 0);
  if (text.length > remaining) state.truncated = true;
}

function addAttachments(state: ExtractionState, node: Record<string, unknown>) {
  function add(attachment: FeishuAttachment) {
    const identity = `${attachment.kind}:${attachment.fileKey}`;
    if (state.seenAttachments.has(identity) || state.attachments.length >= MAX_ATTACHMENTS) return;
    state.seenAttachments.add(identity);
    state.attachments.push(attachment);
  }
  const directImageKey = typeof node.img_key === "string" ? node.img_key : node.image_key;
  const reference = node.tag === "img" || node.tag === "image" ? node.image_id ?? node.img_id : undefined;
  const imageKey = typeof directImageKey === "string" ? state.imageReferences.get(directImageKey) ?? directImageKey
    : (typeof reference === "string" || typeof reference === "number") ? state.imageReferences.get(String(reference)) : undefined;
  if (imageKey) add({ kind: "image", fileKey: imageKey });
  if (typeof node.file_key === "string" && node.file_key) {
    add({ kind: "file", fileKey: node.file_key, fileName: typeof node.file_name === "string" ? node.file_name : undefined });
  }
}

function readImageReferences(node: Record<string, unknown>, state: ExtractionState) {
  const metadata = decodeCard(node.json_attachment);
  if (!isRecord(metadata) || (!isRecord(metadata.images) && !Array.isArray(metadata.images))) return;
  for (const [reference, value] of Object.entries(metadata.images).slice(0, 200)) {
    if (!isRecord(value) || typeof value.origin_key !== "string" || !value.origin_key) continue;
    state.imageReferences.set(reference, value.origin_key);
    for (const key of ["id", "image_id", "img_id"]) {
      if (typeof value[key] === "string" || typeof value[key] === "number") {
        state.imageReferences.set(String(value[key]), value.origin_key);
      }
    }
  }
}

/** Traverse display containers only; callback payloads and arbitrary metadata are not visible card content. */
function walkCard(value: unknown, inherited: Map<string, string>, state: ExtractionState, depth = 0) {
  if (!Array.isArray(value) && !isRecord(value)) return;
  if (depth > MAX_DEPTH || ++state.nodes > MAX_NODES) { state.truncated = true; return; }
  if (Array.isArray(value)) {
    for (const child of value.slice(0, MAX_NODES)) {
      if (state.nodes >= MAX_NODES) { state.truncated = true; break; }
      walkCard(child, inherited, state, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) return;
  const node = withProperty(value);
  const variables = templateVariables(node, inherited);
  const tag = typeof node.tag === "string" ? node.tag : "";
  // Metadata only resolves image nodes that the rendered card actually references.
  readImageReferences(node, state);
  addAttachments(state, node);

  for (const key of ["title", "subtitle"]) addText(state, visibleText(preferredLocale(node[`i18n_${key}`]) ?? node[key], variables));
  let label = visibleText(preferredLocale(node.i18n_text) ?? node.text, variables);
  const localizedContent = preferredLocale(node.i18n_content ?? node.i18n);
  if (typeof localizedContent === "string") label = visibleText(localizedContent, variables);
  if (typeof node.content === "string" && (tag || !/^[\s]*[\[{]/.test(node.content))) {
    const content = visibleText(localizedContent ?? node.content, variables);
    if (label && content !== label) addText(state, label);
    label = content || label;
  }
  if (tag === "button" && label) label = `[按钮] ${label}`;
  addText(state, textWithUrls(label, visibleUrls(node, variables)));
  if (tag === "img" || tag === "image") addText(state, visibleText(node.alt, variables));

  for (const key of ["header", "body"]) {
    const localized = preferredLocale(node[`i18n_${key}`]);
    walkCard(localized ?? node[key], variables, state, depth + 1);
  }
  const localizedElements = preferredLocale(node.i18n_elements);
  walkCard(localizedElements ?? node.elements, variables, state, depth + 1);
  for (const key of ["columns", "fields", "actions", "extra", "children", "items", "rows", "options", "textTagList"]) {
    walkCard(node[key], variables, state, depth + 1);
  }
  // Raw CardKit rich text can contain inline display nodes in content or text arrays.
  for (const key of ["content", "text", "title", "subtitle"]) {
    if (Array.isArray(node[key]) || (isRecord(node[key]) && !visibleText(node[key], variables))) {
      walkCard(node[key], variables, state, depth + 1);
    }
  }
  for (const key of ["json_card", "card"]) {
    if (node[key] !== undefined) walkCard(decodeCard(node[key]), variables, state, depth + 1);
  }
  if (!tag) {
    if (node.data !== undefined) walkCard(decodeCard(node.data), variables, state, depth + 1);
    if (typeof node.content === "string" && /^[\s]*[\[{]/.test(node.content)) {
      walkCard(decodeCard(node.content), variables, state, depth + 1);
    }
  }

  // Template references without a rendered layout can still carry named visible fields.
  if (!tag && (node.type === "template" || typeof node.template_id === "string")) {
    for (const candidate of [node.variables, node.template_variable, node.template_variables]) {
      if (!isRecord(candidate)) continue;
      for (const key of ["title", "subtitle", "content", "text", "body", "description", "summary", "markdown"]) {
        addText(state, visibleText(candidate[key], variables));
      }
      addText(state, textWithUrls("", visibleUrls(candidate, variables)));
      for (const key of ["header", "body", "elements"]) walkCard(candidate[key], variables, state, depth + 1);
    }
  }
}

/** Extract visible card text and deduplicated attachments from a display subtree. */
export function extractInteractiveElementText(
  element: unknown,
  variables: Map<string, string>,
  attachments: FeishuAttachment[],
  depth = 0,
): string[] {
  const state = createState(attachments);
  walkCard(element, variables, state, depth);
  return state.parts;
}

/** Convert rendered and wrapped card content to bounded, agent-readable text. */
export function extractTextFromInteractiveCard(
  content: string,
  options?: { maxChars?: number },
): { text: string; attachments: FeishuAttachment[] } {
  const maxChars = Number.isFinite(options?.maxChars) ? Math.max(1, Math.min(64000, Math.floor(options!.maxChars!))) : 12000;
  const attachments: FeishuAttachment[] = [];
  if (content.length > MAX_JSON_CHARS) return { text: INTERACTIVE_CARD_FALLBACK, attachments };
  const parsed = decodeCard(content || "{}");
  if (!isRecord(parsed) && !Array.isArray(parsed)) {
    const text = !/^[\s]*[\[{]/.test(content) && content.trim() ? content.trim().slice(0, maxChars) : INTERACTIVE_CARD_FALLBACK;
    return { text, attachments };
  }
  const state = createState(attachments, maxChars);
  walkCard(parsed, new Map(), state);
  let text = state.parts.join("\n") || INTERACTIVE_CARD_FALLBACK;
  if (state.truncated && state.parts.length) {
    const suffix = "\n…(truncated)";
    text = `${text.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`.slice(0, maxChars);
  }
  return { text, attachments };
}

function resolvePostBody(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 4 || !isRecord(value)) return undefined;
  if (Array.isArray(value.content)) return value;
  if (isRecord(value.post)) return resolvePostBody(value.post, depth + 1);
  for (const key of [...new Set(["zh_cn", "zh-CN", "en_us", "en-US", ...Object.keys(value)])].slice(0, 200)) {
    const post = resolvePostBody(value[key], depth + 1);
    if (post) return post;
  }
  return undefined;
}

function postInline(value: unknown, state: ExtractionState, depth = 0): string {
  if (depth > MAX_DEPTH || ++state.nodes > MAX_NODES) { state.truncated = true; return ""; }
  if (typeof value === "string") return value.slice(0, state.maxChars);
  if (Array.isArray(value)) {
    const pieces: string[] = [];
    let length = 0;
    for (const child of value.slice(0, MAX_NODES)) {
      if (state.nodes >= MAX_NODES || length >= state.maxChars) { state.truncated = true; break; }
      const piece = postInline(child, state, depth + 1);
      pieces.push(piece);
      length += piece.length;
    }
    return pieces.join("").slice(0, state.maxChars);
  }
  if (!isRecord(value)) return "";
  const node = withProperty(value);
  addAttachments(state, node);
  if (node.tag === "at") return `@${typeof node.user_name === "string" ? node.user_name : "user"}`;
  if (node.tag === "img" || node.tag === "image" || node.tag === "file") return "";
  if (node.tag === "br") return "\n";
  const variables = new Map<string, string>();
  const label = visibleText(node.text ?? node.content, variables);
  if (label || node.tag === "a" || node.tag === "link") return textWithUrls(label, visibleUrls(node, variables));
  const children = node.children ?? node.content ?? node.elements ?? node.items;
  if ((node.tag === "ul" || node.tag === "ol") && Array.isArray(children)) {
    return children.slice(0, MAX_NODES).map((child) => postInline(child, state, depth + 1)).filter(Boolean).join("\n").slice(0, state.maxChars);
  }
  return postInline(children, state, depth + 1);
}

/** Parse message content consistently when expanding a quoted or historical message. */
export function extractTextFromMsgType(
  msgType: string,
  content: string,
  botOpenId?: string,
): { text: string; attachments: FeishuAttachment[] } {
  const attachments: FeishuAttachment[] = [];
  if (msgType === "interactive") return extractTextFromInteractiveCard(content);
  try {
    const json = JSON.parse(content || "{}");
    if (msgType === "text") {
      let text = typeof json.text === "string" ? json.text : "";
      if (botOpenId) text = text.split(`@${botOpenId}`).join("").split(botOpenId).join("");
      return { text: text.trim(), attachments };
    }
    if (msgType === "post") {
      const post = resolvePostBody(json);
      const state = createState(attachments);
      if (post) {
        addText(state, typeof post.title === "string" ? post.title : "");
        for (const paragraph of (post.content as unknown[]).slice(0, MAX_NODES)) {
          if (state.nodes >= MAX_NODES) break;
          addText(state, postInline(paragraph, state), false);
        }
      }
      return { text: state.parts.join("\n"), attachments };
    }
    if (msgType === "image" || msgType === "file") {
      if (isRecord(json)) addAttachments(createState(attachments), json);
      if (attachments.length) return { text: "", attachments };
    }
  } catch {
    // Unknown or malformed message types retain a small readable fallback.
  }
  return { text: content?.trim() ? content.trim().slice(0, 2000) : `[${msgType}]`, attachments };
}
