import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import * as PiSdk from "@earendil-works/pi-coding-agent";
import type { AgentSession, SessionInfo } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { FeishuBridgeRuntime, BridgeJobEvent } from "../../feishu/bridge-runtime.ts";
import { CHILD_SESSION_ENV, ensureRoot, readJson, STATE_PATH, writeJson } from "../../feishu/config.ts";
import { debugLog } from "../../feishu/debug.ts";
import { waitForPrompt } from "../../feishu/prompt-timeout.ts";
import type { ResumeScope, ResumeSessionPage } from "../../feishu/cards.ts";
import type { ReplyCardSink } from "../../feishu/reply-card.ts";
import { normalizeThinkingLevels, type ThinkingStatus } from "../../feishu/thinking.ts";
import type { FeishuState } from "../../feishu/types.ts";
import type { ConversationRuntime, ConversationStatus, ContextUsage, RuntimeModel, StopConversationResult, ConversationTimeouts, FeishuMessageContext } from "../../feishu/runtime.ts";
import type { FeishuTransport } from "../../feishu/transport.ts";
import { ensureWorkspaceExists, resolveWorkspacePath } from "../../feishu/workspace.ts";
import { createFlashFallbackExtension } from "./feishu-model-fallback.ts";
import { createFeishuSessionSettings } from "./feishu-session-settings.ts";
import { feishuRouterEnabled, FLASH_MODEL, isAllowedRoutingModel, isManualSelection, isPriorityRequest, LUNA_MODEL, modelMatches } from "./feishu-model-routing.ts";
import { ContinuationRouting } from "./feishu-continuation-routing.ts";
import { createFeishuContextExtension } from "./feishu-context-tools.ts";
import { appendFeishuSystemPrompt } from "./feishu-system-prompt.ts";

/**
 * Pi Runtime 适配器：
 * 把飞书公共层需要的会话能力映射到 Pi 的 AgentSession API。
 * 第一阶段保持与原 ConversationManager 完全一致的行为。
 */

type ActiveRun = {
  session: AgentSession;
  runId?: string;
  stopped: boolean;
  fallbackAttempted?: boolean;
  startedAt: number;
  toolCalls: number;
  usage: Record<string, { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number }>;
  status?: ReplyCardSink;
  messageContext?: FeishuMessageContext;
  /** 当前轮流式回调（由 promptWithImages 设置） */
  onDelta?: (delta: string) => void;
};

type ModelRuntimeAdapter = {
  getModel(provider: string, id: string): any;
  hasConfiguredAuth(model: any): boolean;
  getAvailable(): Promise<any[]>;
  sessionOptions: Record<string, unknown>;
};

const RESUME_PAGE_SIZE = 10;

export class PiConversationRuntime implements ConversationRuntime {
  private readonly sessions = new Map<string, Promise<AgentSession>>();
  private readonly sessionFileStats = new Map<string, { mtimeMs: number; size: number }>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly continuationRouting = new ContinuationRouting();
  private routingGeneration = 0;
  private modelRuntimePromise: Promise<ModelRuntimeAdapter> | undefined;
  private defaultProvider: string | undefined;
  private defaultModelId: string | undefined;
  private state: FeishuState;
  private readonly cwd: string;
  private readonly bridge?: FeishuBridgeRuntime;
  private readonly timeouts: ConversationTimeouts;
  private readonly getTransport?: () => FeishuTransport | undefined;

  constructor(
    cwd: string,
    bridge?: FeishuBridgeRuntime,
    timeouts: ConversationTimeouts = {},
    getTransport?: () => FeishuTransport | undefined,
  ) {
    this.cwd = cwd;
    this.bridge = bridge;
    this.timeouts = timeouts;
    this.getTransport = getTransport;
    ensureRoot();
    this.state = readJson<FeishuState>(STATE_PATH, { sessions: {} });
    this.state.sessions ||= {};
    this.state.models ||= {};
    this.state.workspaces ||= {};
    this.loadSettingsDefault();
  }

  /** Read global settings default model for fallback in getSelectedModel. */
  private loadSettingsDefault() {
    try {
      const settingsPath = join(getAgentDir(), "settings.json");
      const raw = readFileSync(settingsPath, "utf-8");
      const settings = JSON.parse(raw);
      if (settings.defaultProvider && settings.defaultModel) {
        this.defaultProvider = settings.defaultProvider;
        this.defaultModelId = settings.defaultModel;
      }
    } catch {}
  }

  async prompt(key: string, userText: string, onReply: (text: string) => Promise<void>, onDelta?: (delta: string) => void) {
    return this.promptWithImages(key, userText, [], onReply, undefined, onDelta);
  }

  async promptWithImages(
    key: string,
    userText: string,
    images: Array<{ type: "image"; data: string; mimeType: string }>,
    onReply: (text: string) => Promise<void>,
    status?: ReplyCardSink,
    onDelta?: (delta: string) => void,
    preferredModel?: RuntimeModel,
    currentRequest?: string,
    messageContext?: FeishuMessageContext,
  ) {
    const previous = this.previousTurn(key);
    let routingGeneration = this.routingGeneration;
    const next = previous.then(async () => {
      debugLog("feishu.prompt.start", { key, textLength: userText.length, imageCount: images.length });
      routingGeneration = this.routingGeneration;
      const session = await this.ensureSessionFresh(key);
      preferredModel ??= await this.routeModel(key, userText, images.length > 0, currentRequest ?? userText);
      if (routingGeneration === this.routingGeneration) this.continuationRouting.clear(key);
      if (preferredModel && !modelMatches(session.model, preferredModel)) {
        const modelRuntime = await this.getModelRuntime();
        const nextModel = modelRuntime.getModel(preferredModel.provider, preferredModel.id);
        if (nextModel && modelRuntime.hasConfiguredAuth(nextModel)) await session.setModel(nextModel);
      }
      const run: ActiveRun = {
        session, runId: status?.runId, stopped: false, status, onDelta,
        messageContext: messageContext ? { ...messageContext } : undefined,
        startedAt: Date.now(), toolCalls: 0, usage: {},
      };
      this.activeRuns.set(key, run);
      this.bridge?.beginFeishuInput(session.sessionId);
      // 流式走 session 级订阅（createSession 里）→ run.onDelta，避免漏事件
      let unsub: (() => void) | undefined;
      let deltaCount = 0;
      let deltaChars = 0;
      const previousAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
      if (onDelta) {
        const userOnDelta = onDelta;
        run.onDelta = (delta: string) => {
          deltaCount += 1;
          deltaChars += delta.length;
          userOnDelta(delta);
        };
      }
      try {
        try {
          await this.runPromptWithTimeouts(session, userText, images, key, onReply, status);
          if (!run.stopped && lastAssistantFailed(session)) throw new Error(lastAssistantError(session));
        } catch (error) {
          if (run.stopped) {
            debugLog("feishu.prompt.stopped", { key });
            return;
          }
          throw error;
        }
      } finally {
        if (run.stopped && routingGeneration === this.routingGeneration) this.continuationRouting.clear(key);
        try { unsub?.(); } catch {}
        run.onDelta = undefined;
        if (this.activeRuns.get(key) === run) this.activeRuns.delete(key);
        this.bridge?.endFeishuInput(session.sessionId);
        this.recordSessionFileStat(key, session.sessionFile);
      }
      if (run.stopped) return;
      const lastAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
      const answer = extractLastAssistantText(session);
      debugLog("feishu.prompt.done", {
        key,
        answerLength: answer.length,
        deltaCount,
        deltaChars,
        elapsedMs: Date.now() - run.startedAt,
        model: session.model ? `${session.model.provider}/${session.model.id}` : undefined,
        fallbackAttempted: run.fallbackAttempted === true,
        toolCalls: run.toolCalls,
        usage: run.usage,
      });
      await onReply(answer || "No response.");
      // onReply（ReplyCard.completeWithAnswer）已切到 done；此处仅兜底
      await status?.finish("done");
      if (routingGeneration !== this.routingGeneration) return;
      if (feishuRouterEnabled() && session.model && lastAssistant?.role === "assistant"
        && lastAssistant !== previousAssistant && lastAssistant.stopReason === "stop") {
        this.continuationRouting.record(key, {
          sessionId: session.sessionId,
          workspace: this.getWorkspace(key),
          model: { provider: lastAssistant.provider, id: lastAssistant.model },
        });
      } else {
        this.continuationRouting.clear(key);
      }
    }).catch(async (error) => {
      if (routingGeneration === this.routingGeneration) this.continuationRouting.clear(key);
      const message = error instanceof Error ? error.message : String(error);
      debugLog("feishu.prompt.error", { key, error: message });
      // 错误也写进同一张卡；onReply 若已是 completeWithAnswer 会 no-op（status 非 running）
      if (status && "ensureFinal" in status && typeof (status as any).ensureFinal === "function") {
        (status as any).ensureFinal(`出错了：${message}`);
        await status.finish("failed", message);
      } else {
        await status?.finish("failed", message);
        await onReply(`Pi error: ${message}`);
      }
    });
    this.queues.set(key, next);
    await next;
  }

  /** 供 /status 使用 */
  getStatus(key: string): ConversationStatus {
    const active = this.activeRuns.get(key);
    return {
      cwd: this.getWorkspace(key),
      hasActiveRun: Boolean(active),
      activeStopped: Boolean(active?.stopped),
    };
  }

  async getActualModel(key: string) {
    const cached = this.sessions.get(key);
    const activeModel = cached ? (await cached).model : undefined;
    const model = activeModel ? toRuntimeModel(activeModel) : await this.getSelectedModel(key);
    if (!model) return "默认模型";
    return `${model.provider}/${model.id}`;
  }

  /** 当前 Pi 会话的思考强度和该模型可用的档位。 */
  async getThinkingStatus(key: string): Promise<ThinkingStatus> {
    const session = await this.getSession(key);
    return this.getThinkingStatusForSession(session);
  }

  async getContextStatus(key: string): Promise<ContextUsage | null> {
    try {
      const session = await this.getSession(key);
      const anySession = session as any;
      const tokens = anySession.contextTokens ?? anySession.tokenCount ?? null;
      const contextWindow = anySession.contextWindow ?? anySession.model?.contextWindow ?? null;
      const percent = tokens != null && contextWindow ? (Number(tokens) / Number(contextWindow)) * 100 : null;
      return { tokens: tokens != null ? Number(tokens) : null, contextWindow: contextWindow != null ? Number(contextWindow) : null, percent };
    } catch {
      return null;
    }
  }

  async stopConversation(key: string, onReply: (text: string) => Promise<void>, runId?: string): Promise<StopConversationResult> {
    const active = this.activeRuns.get(key);
    if (!active) {
      const message = "当前没有进行中的处理。";
      await onReply(message);
      return { status: "not_running", message };
    }
    if (runId && active.runId && active.runId !== runId) {
      const message = "这张任务卡片已不是当前进行中的任务。";
      await onReply(message);
      debugLog("feishu.prompt.stop_stale", { key, runId, activeRunId: active.runId });
      return { status: "stale", message };
    }

    active.stopped = true;
    const body = active.status?.bodyText || "";
    await active.status?.stopImmediately("已停止");
    try {
      await active.session.abort();
      debugLog("feishu.prompt.abort", { key });
      const message = "已停止";
      await onReply(message);
      return { status: "stopped", message, body };
    } catch (error) {
      active.stopped = false;
      debugLog("feishu.prompt.abort_error", { key, error: error instanceof Error ? error.message : String(error) });
      const message = "停止失败，请重试。";
      await onReply(message);
      return { status: "failed", message };
    }
  }

  async newConversation(key: string, onReply: (text: string) => Promise<void>) {
    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      const cached = this.sessions.get(key);
      if (cached) {
        try { (await cached).dispose(); } catch {}
      }
      this.sessions.delete(key);
      this.continuationRouting.clear(key);
      this.sessionFileStats.delete(key);
      delete this.state.sessions[key];
      writeJson(STATE_PATH, this.state);
      await onReply("已创建新会话。旧会话历史已保留，下一条消息会从新上下文开始。");
    }).catch(async (error) => {
      await onReply(`Pi error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  async listResumeSessions(key: string, scope: ResumeScope, page: number): Promise<ResumeSessionPage> {
    const sessions = await this.getResumeSessions(key, scope);
    const normalizedPage = Math.max(0, Math.floor(page));
    const total = sessions.length;
    const totalPages = Math.max(1, Math.ceil(total / RESUME_PAGE_SIZE));
    const clampedPage = Math.min(normalizedPage, totalPages - 1);
    const currentSessionPath = this.normalizeSessionPath(this.state.sessions[key]);
    const start = clampedPage * RESUME_PAGE_SIZE;
    const items = sessions.slice(start, start + RESUME_PAGE_SIZE).map((session) => {
      const sessionPath = this.normalizeSessionPath(session.path) || session.path;
      return {
        path: session.path,
        title: session.name?.trim() || summarizeFirstMessage(session.firstMessage),
        subtitle: session.name?.trim()
          ? summarizeFirstMessage(session.firstMessage)
          : `消息数：${session.messageCount}`,
        modifiedLabel: formatModifiedLabel(session.modified),
        workspaceLabel: scope === "all" ? formatWorkspaceLabel(session.cwd) : undefined,
        isCurrent: Boolean(currentSessionPath && sessionPath && currentSessionPath === sessionPath),
      };
    });

    return {
      key,
      workspacePath: this.getWorkspace(key),
      scope,
      page: clampedPage,
      total,
      totalPages,
      items,
    };
  }

  async resumeConversation(key: string, sessionPathInput: string, onReply: (text: string) => Promise<void>) {
    if (this.activeRuns.has(key)) {
      await onReply("当前还有进行中的处理，请先发送 /stop，再切换历史会话。");
      return;
    }

    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      const sessionPath = this.normalizeExistingSessionPath(sessionPathInput);
      const sessionInfo = await this.findSessionInfo(sessionPath);
      if (!sessionInfo) {
        await onReply("这条历史会话不存在，可能已经被删除。请重新打开 /resume 选择。");
        return;
      }

      const currentPath = this.normalizeSessionPath(this.state.sessions[key]);
      this.continuationRouting.clear(key);
      if (currentPath === sessionPath) {
        this.state.workspaces![key] = sessionInfo.cwd || this.getWorkspace(key);
        writeJson(STATE_PATH, this.state);
        this.recordSessionFileStat(key, sessionPath);
        await onReply(`你已经在这个历史会话里了。\n当前工作区：${this.state.workspaces![key]}`);
        return;
      }

      const cached = this.sessions.get(key);
      if (cached) {
        try { (await cached).dispose(); } catch {}
      }

      this.sessions.delete(key);
      this.continuationRouting.clear(key);
      this.sessionFileStats.delete(key);
      this.state.sessions[key] = sessionPath;
      this.state.workspaces![key] = sessionInfo.cwd || this.cwd;
      writeJson(STATE_PATH, this.state);
      this.recordSessionFileStat(key, sessionPath);
      await onReply([
        `已切换到历史会话：${sessionInfo.name?.trim() || summarizeFirstMessage(sessionInfo.firstMessage)}`,
        `工作区：${this.state.workspaces![key]}`,
        "下一条消息会继续接着这个会话往下聊。",
      ].join("\n"));
    }).catch(async (error) => {
      await onReply(`Pi error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  async selectModel(key: string, provider: string, modelId: string, onReply: (text: string) => Promise<void>) {
    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      if (feishuRouterEnabled() && !isAllowedRoutingModel({ provider, id: modelId })) {
        await onReply("当前只开放 GPT-6 Luna 和 DeepSeek 4.1 Flash。");
        return;
      }
      const modelRuntime = await this.getModelRuntime();
      const model = modelRuntime.getModel(provider, modelId);
      if (!model || !modelRuntime.hasConfiguredAuth(model)) {
        await onReply(`这个模型当前不可用：${provider}/${modelId}。请发送 /model 重新选择。`);
        return;
      }

      const existing = this.state.models?.[key];
      this.state.models![key] = { provider, id: modelId, thinkingLevel: existing?.thinkingLevel, routingMode: "manual" };
      writeJson(STATE_PATH, this.state);

      const cached = this.sessions.get(key);
      if (cached) {
        try { (await cached).dispose(); } catch {}
      }
      this.sessions.delete(key);
      this.continuationRouting.clear(key);
      this.sessionFileStats.delete(key);
      await onReply(feishuRouterEnabled()
        ? `已切换到 ${provider}/${modelId}。当前飞书会话后续优先使用这个模型；KDH/Codex review 固定规则和图片能力要求仍生效。发送 /model auto 可恢复自动路由。`
        : `已切换到 ${provider}/${modelId}。当前飞书会话后续都会使用这个模型。`);
    }).catch(async (error) => {
      await onReply(`Pi error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  async enableAutoRouting(key: string, onReply: (text: string) => Promise<void>) {
    if (!feishuRouterEnabled()) {
      await onReply("当前机器人尚未启用自动模型路由。");
      return;
    }
    const next = this.previousTurn(key).then(async () => {
      this.continuationRouting.clear(key);
      this.state.models![key] = { ...(this.state.models?.[key] || FLASH_MODEL), routingMode: "auto" };
      writeJson(STATE_PATH, this.state);
      await onReply("已恢复自动模型路由，下一条请求会根据任务难度选择模型。");
    }).catch(async (error) => {
      await onReply(`Pi error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  async selectThinkingLevel(key: string, level: string, onReply: (text: string) => Promise<void>) {
    if (this.activeRuns.has(key)) {
      await onReply("当前正在生成回复，请等待完成后再调整思考强度。");
      return;
    }
    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      const session = await this.getSession(key);
      const status = this.getThinkingStatusForSession(session);
      if (!status.available) {
        await onReply("无法从 Pi 读取当前模型可用的 thinking levels，未做任何修改。请稍后重试。");
        return;
      }
      if (!status.availableLevels.includes(level)) {
        await onReply(`Pi 当前模型不支持 thinking level \`${level}\`。请重新发送 /thinking 选择。`);
        return;
      }

      const sessionApi = session as any;
      if (typeof sessionApi.setThinkingLevel !== "function") {
        await onReply("当前 Pi 版本不支持从飞书调整思考强度。请升级 Pi 后重试。");
        return;
      }
      sessionApi.setThinkingLevel(level);
      const existing = this.state.models?.[key];
      if (existing) {
        this.state.models![key] = { ...existing, thinkingLevel: level };
        writeJson(STATE_PATH, this.state);
      }
      const effective = this.getThinkingStatusForSession(session).currentLevel || level;
      await onReply(`Thinking level set to: ${effective}`);
    }).catch(async (error) => {
      await onReply(`Pi error: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  getWorkspace(key: string) {
    return this.state.workspaces?.[key] || this.cwd;
  }

  async switchWorkspace(key: string, workspaceInput: string | undefined, onReply: (text: string) => Promise<void>) {
    if (!workspaceInput) {
      const current = this.getWorkspace(key);
      await onReply([
        `当前工作区：${current}`,
        "用法：/workspace /绝对路径",
        "也支持：/workspace ~/your/project",
      ].join("\n"));
      return;
    }

    const previous = this.previousTurn(key);
    const next = previous.then(async () => {
      const workspace = resolveWorkspacePath(workspaceInput);
      const cached = this.sessions.get(key);
      if (cached) {
        try { (await cached).dispose(); } catch {}
      }
      this.sessions.delete(key);
      this.continuationRouting.clear(key);
      this.sessionFileStats.delete(key);
      delete this.state.sessions[key];
      this.state.workspaces![key] = workspace;
      writeJson(STATE_PATH, this.state);
      await onReply(`已切换到工作区：${workspace}\n下一条消息会在这个目录里创建新的 Pi 会话。`);
    }).catch(async (error) => {
      await onReply(error instanceof Error ? error.message : `Pi error: ${String(error)}`);
    });
    this.queues.set(key, next);
    await next;
  }

  async getAvailableModels(key?: string): Promise<RuntimeModel[]> {
    const modelRuntime = await this.getModelRuntime();
    let available = await modelRuntime.getAvailable();
    if (feishuRouterEnabled() && key && !available.some((model) => model.provider === LUNA_MODEL.provider && model.id === LUNA_MODEL.id)) {
      await this.getSession(key);
      available = await modelRuntime.getAvailable();
    }
    return [...available]
      .map(toRuntimeModel)
      .filter((model) => !feishuRouterEnabled() || isAllowedRoutingModel(model))
      .sort((a, b) => {
        const providerCmp = a.provider.localeCompare(b.provider);
        if (providerCmp !== 0) return providerCmp;
        return a.id.localeCompare(b.id);
      });
  }

  async getSelectedModel(key: string, hasImages = false): Promise<RuntimeModel | undefined> {
    if (feishuRouterEnabled()) {
      const modelRuntime = await this.getModelRuntime();
      const selected = this.state.models?.[key];
      if (isManualSelection(selected)) {
        const manual = modelRuntime.getModel(selected!.provider, selected!.id);
        if (manual && modelRuntime.hasConfiguredAuth(manual) && (!hasImages || toRuntimeModel(manual).supportsImage)) {
          return toRuntimeModel(manual);
        }
      }
      let luna = modelRuntime.getModel(LUNA_MODEL.provider, LUNA_MODEL.id);
      if (!luna && !this.sessions.has(key)) {
        await this.getSession(key);
        luna = modelRuntime.getModel(LUNA_MODEL.provider, LUNA_MODEL.id);
      }
      if (luna && modelRuntime.hasConfiguredAuth(luna) && (!hasImages || toRuntimeModel(luna).supportsImage)) {
        return toRuntimeModel(luna);
      }
      if (!hasImages) {
        const flash = modelRuntime.getModel(FLASH_MODEL.provider, FLASH_MODEL.id);
        if (flash && modelRuntime.hasConfiguredAuth(flash)) return toRuntimeModel(flash);
      }
      return undefined;
    }
    const native = await this.getSelectedNativeModel(key);
    return native ? toRuntimeModel(native) : undefined;
  }

  async routeModel(key: string, prompt: string, hasImages = false, currentRequest = prompt): Promise<RuntimeModel | undefined> {
    if (!feishuRouterEnabled()) return this.getSelectedModel(key);
    const started = Date.now();
    const modelRuntime = await this.getModelRuntime();
    const priority = isPriorityRequest(this.getWorkspace(key), currentRequest);
    const selected = this.state.models?.[key];
    let target: Pick<RuntimeModel, "provider" | "id"> | undefined;
    let reason = "budget_cap";
    if (priority) {
      target = LUNA_MODEL;
      reason = "priority";
    } else if (isManualSelection(selected)) {
      const manual = selected && modelRuntime.getModel(selected.provider, selected.id);
      if (manual && modelRuntime.hasConfiguredAuth(manual) && (!hasImages || toRuntimeModel(manual).supportsImage)) {
        target = selected;
        reason = "manual";
      } else if (hasImages) {
        target = LUNA_MODEL;
        reason = "image_capability";
      }
    } else if (hasImages) {
      target = LUNA_MODEL;
      reason = "image_capability";
    } else {
      const session = await this.getSession(key);
      const continuation = prompt.trim() === currentRequest.trim()
        ? this.continuationRouting.get(key, {
          sessionId: session.sessionId, workspace: this.getWorkspace(key), currentRequest,
        })
        : undefined;
      const retainedModel = continuation && modelRuntime.getModel(continuation.provider, continuation.id);
      if (retainedModel && isAllowedRoutingModel(retainedModel) && modelRuntime.hasConfiguredAuth(retainedModel)) {
        debugLog("feishu.router.selected", {
          key, model: `${retainedModel.provider}/${retainedModel.id}`, priority,
          reason: "continuation", latencyMs: Date.now() - started,
        });
        return toRuntimeModel(retainedModel);
      }
      target = LUNA_MODEL;
    }
    if (target) {
      let model = modelRuntime.getModel(target.provider, target.id);
      if (!model) {
        await this.getSession(key);
        model = modelRuntime.getModel(target.provider, target.id);
      }
      if (model && modelRuntime.hasConfiguredAuth(model) && (!hasImages || toRuntimeModel(model).supportsImage)) {
        debugLog("feishu.router.selected", { key, model: `${target.provider}/${target.id}`, priority, reason, latencyMs: Date.now() - started });
        return toRuntimeModel(model);
      }
      reason = "target_unavailable";
    }
    const fallback = await this.getSelectedModel(key, hasImages);
    debugLog("feishu.router.selected", { key, model: fallback ? `${fallback.provider}/${fallback.id}` : undefined, priority, reason, latencyMs: Date.now() - started });
    return fallback;
  }

  /** 内部使用的原生 Pi 模型（不跨出本适配器）。 */
  private async getSelectedNativeModel(key: string) {
    const modelRuntime = await this.getModelRuntime();
    const selected = this.state.models?.[key];
    if (selected && (!feishuRouterEnabled() || isAllowedRoutingModel(selected))) {
      const model = modelRuntime.getModel(selected.provider, selected.id);
      if (model && modelRuntime.hasConfiguredAuth(model)) return model;
    }
    const cached = this.sessions.get(key);
    if (cached) {
      const model = (await cached).model;
      if (!feishuRouterEnabled() || isAllowedRoutingModel(model ? toRuntimeModel(model) : undefined)) return model;
    }
    // Check settings default model before falling back to first available
    if (this.defaultProvider && this.defaultModelId) {
      const defaultModel = modelRuntime.getModel(this.defaultProvider, this.defaultModelId);
      if (defaultModel && modelRuntime.hasConfiguredAuth(defaultModel)) {
        return defaultModel;
      }
    }
    const available = await this.getAvailableModels();
    const first = available[0];
    return first ? modelRuntime.getModel(first.provider, first.id) : undefined;
  }

  private getModelRuntime() {
    this.modelRuntimePromise ||= createModelRuntimeAdapter();
    return this.modelRuntimePromise;
  }

  resetMemory() {
    this.routingGeneration += 1;
    for (const session of this.sessions.values()) {
      void session.then((s) => s.dispose()).catch(() => undefined);
    }
    this.sessions.clear();
    this.sessionFileStats.clear();
    this.queues.clear();
    this.continuationRouting.reset();
    this.state = { sessions: {}, models: {}, workspaces: {} };
  }

  private recordSessionFileStat(key: string, sessionFile?: string) {
    const filePath = sessionFile || this.state.sessions[key];
    if (!filePath) {
      this.sessionFileStats.delete(key);
      return;
    }
    try {
      if (existsSync(filePath)) {
        const stat = statSync(filePath);
        this.sessionFileStats.set(key, {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        });
      }
    } catch {}
  }

  private async ensureSessionFresh(key: string): Promise<AgentSession> {
    const cachedPromise = this.sessions.get(key);
    if (!cachedPromise) {
      return this.getSession(key);
    }
    const sessionFile = this.state.sessions[key];
    const recorded = this.sessionFileStats.get(key);
    if (sessionFile && existsSync(sessionFile)) {
      try {
        const currentStat = statSync(sessionFile);
        const isModified = recorded
          ? currentStat.mtimeMs > recorded.mtimeMs || currentStat.size !== recorded.size
          : false;
        if (isModified) {
          debugLog("feishu.pi.session_hot_reload", {
            key,
            sessionFile,
            recordedMtime: recorded?.mtimeMs,
            currentMtime: currentStat.mtimeMs,
            recordedSize: recorded?.size,
            currentSize: currentStat.size,
          });
          try {
            const oldSession = await cachedPromise;
            oldSession.dispose();
          } catch {}
          this.sessions.delete(key);
          this.continuationRouting.clear(key);
          const refreshed = this.createSession(key);
          this.sessions.set(key, refreshed);
          return refreshed;
        }
        if (!recorded) {
          this.sessionFileStats.set(key, {
            mtimeMs: currentStat.mtimeMs,
            size: currentStat.size,
          });
        }
      } catch {}
    }
    return cachedPromise;
  }

  private getSession(key: string): Promise<AgentSession> {
    const cached = this.sessions.get(key);
    if (cached) return cached;
    const created = this.createSession(key);
    this.sessions.set(key, created);
    return created;
  }

  private getThinkingStatusForSession(session: AgentSession): ThinkingStatus {
    const sessionApi = session as any;
    const currentLevel = typeof sessionApi.thinkingLevel === "string" && sessionApi.thinkingLevel.trim()
      ? sessionApi.thinkingLevel
      : undefined;
    if (typeof sessionApi.getAvailableThinkingLevels !== "function") {
      return { currentLevel, availableLevels: [], available: false };
    }
    try {
      return {
        currentLevel,
        availableLevels: normalizeThinkingLevels(sessionApi.getAvailableThinkingLevels()),
        available: true,
      };
    } catch {
      return { currentLevel, availableLevels: [], available: false };
    }
  }

  private previousTurn(key: string) {
    // Keep a conversation serial for as long as Pi needs. A bridge-side queue
    // timeout can start a second turn while the first is still streaming.
    return this.queues.get(key) || Promise.resolve();
  }

  private notifyMs() {
    const sec = this.timeouts.promptNotifySec;
    return typeof sec === "number" && Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0;
  }

  private hardTimeoutMs() {
    const sec = this.timeouts.promptTimeoutSec;
    return typeof sec === "number" && Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0;
  }

  private async runPromptWithTimeouts(
    session: AgentSession,
    userText: string,
    images: Array<{ type: "image"; data: string; mimeType: string }>,
    key: string,
    onReply: (text: string) => Promise<void>,
    status?: ReplyCardSink,
  ) {
    const notifyMs = this.notifyMs();
    const hardMs = this.hardTimeoutMs();
    const hardSec = Math.round(hardMs / 1000);
    await waitForPrompt(session.prompt(userText, images.length ? { images } : undefined), {
      notifyMs,
      hardMs,
      hardTimeoutMessage: `Pi 模型处理超时（超过 ${hardSec} 秒）仍未完成，已中止处理。可调大 config.json 中的 promptTimeoutSec。`,
      onStillRunning: () => {
        debugLog("feishu.prompt.notify_still_running", { key, elapsedMs: notifyMs });
        // A ReplyCard stays visibly "replying"; sending this as a final answer
        // would prematurely close the same card, so only non-card callers get
        // the legacy notice.
        if (status) return;
        void onReply("⏳ 仍在处理中，没有失败。请耐心等待，也可以点击「停止」中止。")
          .catch(() => undefined);
      },
      onHardTimeout: async () => {
        debugLog("feishu.prompt.hard_timeout", { key, elapsedMs: hardMs });
        try {
          await session.abort();
        } catch {}
      },
    });
  }

  private async createSession(key: string): Promise<AgentSession> {
    const workspaceCwd = this.getWorkspace(key);
    ensureWorkspaceExists(workspaceCwd);
    const existingFile = this.state.sessions[key];
    const selected = this.state.models?.[key];
    const modelRuntime = await this.getModelRuntime();
    const model = selected ? modelRuntime.getModel(selected.provider, selected.id) : undefined;
    const sessionManager = existingFile && existsSync(existingFile)
      ? SessionManager.open(existingFile, undefined, workspaceCwd)
      : SessionManager.create(workspaceCwd);

    const settingsManager = createFeishuSessionSettings(workspaceCwd, getAgentDir(), feishuRouterEnabled());

    const loader = new DefaultResourceLoader({
      cwd: workspaceCwd,
      agentDir: getAgentDir(),
      settingsManager,
      extensionFactories: [
        ...(this.getTransport ? [createFeishuContextExtension({
          getTransport: this.getTransport,
          getScope: () => this.activeRuns.get(key)?.messageContext,
        })] : []),
        ...(feishuRouterEnabled() ? [createFlashFallbackExtension({
          settings: settingsManager,
          getRun: () => this.activeRuns.get(key),
          onFallback: (from, error) => debugLog("feishu.router.retry", {
            key, from, to: `${FLASH_MODEL.provider}/${FLASH_MODEL.id}`, error,
          }),
        })] : []),
      ],
      extensionsOverride: (base) => ({
        ...base,
        extensions: feishuRouterEnabled()
          ? base.extensions.filter((extension) => !extension.path.endsWith("/model-failover.ts"))
          : base.extensions,
      }),
      appendSystemPromptOverride: appendFeishuSystemPrompt,
    });

    const previousChildEnv = process.env[CHILD_SESSION_ENV];
    process.env[CHILD_SESSION_ENV] = "1";
    try {
      await loader.reload();
    } finally {
      if (previousChildEnv === undefined) delete process.env[CHILD_SESSION_ENV];
      else process.env[CHILD_SESSION_ENV] = previousChildEnv;
    }

    const { session } = await createAgentSession({
      cwd: workspaceCwd,
      agentDir: getAgentDir(),
      ...modelRuntime.sessionOptions,
      model,
      sessionManager,
      settingsManager,
      resourceLoader: loader,
    } as any);

    await session.bindExtensions({});
    this.bridge?.attachSession(key, session.sessionId);
    // 会话级长期订阅：保证 text_delta 在 prompt 期间一定能收到
    session.subscribe((event: any) => {
      const run = this.activeRuns.get(key);
      if (run && event.type === "tool_execution_start") run.toolCalls += 1;
      if (run && event.type === "message_end" && event.message?.role === "assistant") {
        const message = event.message;
        const modelKey = `${message.provider}/${message.model}`;
        const totals = run.usage[modelKey] ||= { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        totals.calls += 1;
        for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
          const value = message.usage?.[field];
          if (typeof value === "number" && Number.isFinite(value)) totals[field] += value;
        }
      }
      run?.status?.updateFromEvent(event);
      const delta = extractAssistantTextDelta(event);
      if (delta && run && !run.stopped) {
        // 优先 onDelta（与 prompt 绑定）；否则直接 append 到 status 卡
        if (run.onDelta) run.onDelta(delta);
        else if (run.status && typeof (run.status as any).append === "function") {
          (run.status as any).append(delta);
        }
      }
      if (event.type === "message_end") {
        handlePiMessageEnd(this.bridge, session.sessionId, key, event.message);
      }
    });

    const desiredThinkingLevel = this.state.models?.[key]?.thinkingLevel;
    if (desiredThinkingLevel && typeof (session as any).setThinkingLevel === "function") {
      try {
        (session as any).setThinkingLevel(desiredThinkingLevel);
      } catch {}
    }

    if (session.sessionFile && this.state.sessions[key] !== session.sessionFile) {
      this.state.sessions[key] = session.sessionFile;
      writeJson(STATE_PATH, this.state);
    }
    this.recordSessionFileStat(key, session.sessionFile);
    return session;
  }

  private async getResumeSessions(key: string, scope: ResumeScope) {
    const base = scope === "all"
      ? await SessionManager.listAll()
      : await SessionManager.list(this.getWorkspace(key));
    return [...base].sort((a, b) => toTimeMs(b.modified) - toTimeMs(a.modified));
  }

  private async findSessionInfo(sessionPath: string): Promise<SessionInfo | undefined> {
    const currentWorkspace = this.getWorkspaceFromSessionFile(sessionPath);
    const localSessions = currentWorkspace ? await SessionManager.list(currentWorkspace) : [];
    const normalizedTarget = this.normalizeSessionPath(sessionPath);
    const fromLocal = localSessions.find((item) => this.normalizeSessionPath(item.path) === normalizedTarget);
    if (fromLocal) return fromLocal;
    const allSessions = await SessionManager.listAll();
    return allSessions.find((item) => this.normalizeSessionPath(item.path) === normalizedTarget);
  }

  private getWorkspaceFromSessionFile(sessionPath: string) {
    try {
      return SessionManager.open(sessionPath).getCwd();
    } catch {
      return undefined;
    }
  }

  private normalizeExistingSessionPath(path: string) {
    if (!path || !existsSync(path)) {
      throw new Error("历史会话不存在，可能已经被删除。");
    }
    return realpathSync(path);
  }

  private normalizeSessionPath(path: string | undefined) {
    if (!path) return undefined;
    try {
      return existsSync(path) ? realpathSync(path) : path;
    } catch {
      return path;
    }
  }
}

/**
 * Pi changed its model-session API between releases. Keep the bridge usable
 * with both the AuthStorage/ModelRegistry API and the newer ModelRuntime API.
 */
async function createModelRuntimeAdapter(): Promise<ModelRuntimeAdapter> {
  const sdk = PiSdk as any;
  if (typeof sdk.ModelRuntime?.create === "function") {
    const runtime = await sdk.ModelRuntime.create();
    return {
      getModel: (provider, id) => runtime.getModel(provider, id),
      hasConfiguredAuth: (model) => runtime.hasConfiguredAuth(model.provider),
      getAvailable: async () => [...await runtime.getAvailable()],
      sessionOptions: { modelRuntime: runtime },
    };
  }

  if (typeof sdk.AuthStorage?.create === "function" && typeof sdk.ModelRegistry?.create === "function") {
    const authStorage = sdk.AuthStorage.create();
    const modelRegistry = sdk.ModelRegistry.create(authStorage);
    return {
      getModel: (provider, id) => modelRegistry.find(provider, id),
      hasConfiguredAuth: (model) => modelRegistry.hasConfiguredAuth(model),
      getAvailable: async () => [...await modelRegistry.getAvailable()],
      sessionOptions: { authStorage, modelRegistry },
    };
  }

  throw new Error("当前 Pi 版本不支持创建飞书会话所需的模型运行时。");
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}


/** 从 Pi AgentSession 事件中提取 assistant 最终可见文本增量 */
function extractAssistantTextDelta(event: any): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  // 标准：message_update + assistantMessageEvent.text_delta
  if (event.type === "message_update") {
    const ame = event.assistantMessageEvent;
    if (ame?.type === "text_delta" && typeof ame.delta === "string" && ame.delta) {
      return ame.delta;
    }
    // 兼容：delta 挂在 event 上
    if (typeof event.delta === "string" && event.delta) return event.delta;
  }
  // 兼容：顶层 text_delta
  if (event.type === "text_delta" && typeof event.delta === "string" && event.delta) {
    return event.delta;
  }
  return undefined;
}

function extractLastAssistantText(session: AgentSession): string {
  const messages = [...(session.messages || [])].reverse();
  for (const msg of messages as any[]) {
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) {
      return content
        .map((p) => p?.type === "text" ? p.text : "")
        .join("")
        .trim();
    }
  }
  return "";
}

function lastAssistantFailed(session: AgentSession): boolean {
  const message = [...(session.messages || [])].reverse().find((item: any) => item.role === "assistant") as any;
  return message?.stopReason === "error";
}

function lastAssistantError(session: AgentSession): string {
  const message = [...(session.messages || [])].reverse().find((item: any) => item.role === "assistant") as any;
  return message?.errorMessage || "Model request failed";
}

/** 把 Pi 原生模型对象转换成平台无关的 RuntimeModel（禁止原生对象泄漏到飞书层）。 */
function toRuntimeModel(model: any): RuntimeModel {
  const input = Array.isArray(model?.input) ? model.input : [];
  return {
    provider: String(model?.provider ?? ""),
    id: String(model?.id ?? ""),
    name: typeof model?.name === "string" ? model.name : undefined,
    supportsImage: input.includes("image"),
  };
}

/**
 * 把 Pi 的 message_end 事件解析成平台无关的桥接事件（Pi 内部任务回传）。
 * 原 ConversationManager.handleMessageEnd 的等价逻辑。
 */
export function handlePiMessageEnd(
  bridge: FeishuBridgeRuntime | undefined,
  sessionId: string | undefined,
  sessionKey: string | undefined,
  message: any,
) {
  if (!bridge || !sessionId || !message) return;

  if (message.role === "toolResult" && message.toolName === "schedule_prompt") {
    const details = message.details || {};
    if (details.action !== "add") return;
    const rawJobs = Array.isArray(details.jobs) ? details.jobs : [];
    const jobs: Array<{ id: string; name?: string }> = [];
    for (const job of rawJobs) {
      if (!job?.id) continue;
      jobs.push({
        id: String(job.id),
        name: typeof job.name === "string" ? job.name : undefined,
      });
    }
    if (jobs.length) {
      bridge.handleJobEvent({ kind: "created", sessionId, sessionKey, jobs });
    }
    return;
  }

  if (message.role === "custom" && message.customType === "scheduled_prompt") {
    const details = message.details || {};
    const jobId = typeof details.jobId === "string" ? details.jobId : "";
    if (!jobId) return;

    if (details.mode === "subagent_done" && typeof details.output === "string") {
      bridge.handleJobEvent({
        kind: "done",
        sessionId,
        jobId,
        text: details.output,
        dedupeKey: `subagent_done:${jobId}:${message.id || details.output}`,
      });
      return;
    }

    if (details.mode === "subagent_error" && typeof details.error === "string") {
      bridge.handleJobEvent({
        kind: "error",
        sessionId,
        jobId,
        error: details.error,
        dedupeKey: `subagent_error:${jobId}:${message.id || details.error}`,
      });
      return;
    }

    bridge.handleJobEvent({ kind: "marker", sessionId, jobId });
    return;
  }

  if (message.role === "assistant") {
    const text = extractMessageText(message);
    bridge.handleJobEvent({
      kind: "output",
      sessionId,
      text,
      messageId: message.id,
      timestamp: message.timestamp,
    });
  }
}

function extractMessageText(message: any) {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => part?.type === "text" ? part.text : "")
    .join("")
    .trim();
}

function summarizeFirstMessage(text: string) {
  const normalized = (text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "未命名会话";
  return normalized.length > 36 ? `${normalized.slice(0, 35)}...` : normalized;
}

function formatModifiedLabel(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function formatWorkspaceLabel(cwd: string) {
  if (!cwd) return "(unknown)";
  return `${basename(cwd)} · ${cwd}`;
}

function toTimeMs(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}
