import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { logger } from "./logger";
import { safetyManager } from "./safety";
import { configManager } from "./config";
import { isStopped, onStop } from "./emergency-stop";
import { taskStore } from "./task-store";
import { taskArtifacts } from "./task-artifacts";
import { desktopDriver } from "./desktop-driver";
import type { WindowInfo } from "./desktop-driver";
import { pickAgentProfile, profileConfigured } from "./app-profiles";
import { buildDraft, draftDedupeKey } from "./wechat-draft";
import { sanitizeToolOutput } from "./prompt-guard";
import { IPC } from "../common/types";
import type { DesktopTask, TaskKind, TaskStep, TaskConfirmRequest, TaskEvent, AppProfile, WechatDraftPayload } from "../common/types";

/**
 * 桌面任务引擎（项目书 P1）。
 *
 * 职责边界：
 * - 任务规划/状态/验收都在这里（主进程），MCP 只是「眼睛和手」；
 * - 一次只允许一个会改变前台窗口/键鼠状态的任务执行，其余排队（§2.1）；
 * - 每一步按「观察 → 动作 → 等待 → 验证」推进，观察证据写入步骤（A1/A3）；
 * - 长任务状态与语音六态分离：进度走 TASK_EVENT 到面板，不依赖 60 秒看门狗；
 * - 急停/取消/暂停在每步边界与动作前检查；结果落 task-artifacts，分页可读。
 */

/** 步骤中途取消/暂停的控制流信号 */
class TaskCancelled extends Error {}
class TaskPaused extends Error {}

export interface CreateTaskInput {
  kind: TaskKind;
  goal: string;
  targetApp?: string;
  params: Record<string, unknown>;
  source?: "voice" | "text" | "panel" | "model";
}

interface ConfirmWaiter {
  resolve: (r: { approved: boolean; note?: string }) => void;
}

/** 每个任务允许的动作语义（ActionCategory 白名单，供策略校验与展示） */
const KIND_ALLOWED: Record<TaskKind, string[]> = {
  browser_research: ["observe", "local_input", "process_or_shell"],
  coding_agent: ["observe", "local_input", "process_or_shell"],
  wechat_draft: ["observe", "local_input"],
};

class TaskRunner extends EventEmitter {
  private tasks = new Map<string, DesktopTask>();
  private order: string[] = []; // 创建顺序（面板列表用）
  private queue: string[] = []; // 待执行队列
  private currentTaskId: string | null = null;
  private cancelled = new Set<string>();
  private paused = new Set<string>();
  private confirmWaiters = new Map<string, ConfirmWaiter>();
  private executedActions = new Set<string>(); // 幂等键（会话内）
  private dedupe = new Set<string>();
  private panelGetter: (() => BrowserWindow | null) | null = null;
  private pumping = false;

  init(panelGetter: () => BrowserWindow | null): void {
    this.panelGetter = panelGetter;
    const restored = taskStore.restoreOnStartup();
    for (const t of restored) {
      this.tasks.set(t.taskId, t);
      this.order.push(t.taskId);
    }
    const resumed = restored.filter((t) => t.status === "waiting_user");
    if (resumed.length) {
      logger.info(`[TaskRunner] 恢复了 ${resumed.length} 个未完成任务（全部为已暂停，等待用户处理）`);
    }
    // 急停：取消队列与等待（与语音打断分开；急停处理器彼此独立）
    onStop((reason) => this.cancelAll(reason));
  }

  /* ---------------- 查询 ---------------- */

  list(): DesktopTask[] {
    return this.order
      .map((id) => this.tasks.get(id))
      .filter((t): t is DesktopTask => Boolean(t))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(taskId: string): DesktopTask | null {
    return this.tasks.get(taskId) ?? null;
  }

  isBusy(): boolean {
    return this.currentTaskId !== null || this.queue.length > 0;
  }

  /* ---------------- 创建 ---------------- */

  createTask(input: CreateTaskInput): DesktopTask {
    const taskId = `task_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
    const kind = input.kind;
    const goal = String(input.goal || "").trim() || "（未提供目标描述）";
    const targetApp =
      kind === "browser_research" ? "浏览器" : kind === "wechat_draft" ? "微信" : String(input.targetApp || "用户配置的编码 Agent");

    const task: DesktopTask = {
      taskId,
      kind,
      goal,
      targetApp,
      steps: this.buildSteps(kind, input.params),
      status: "queued",
      allowedActions: [...KIND_ALLOWED[kind]],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      currentStepIndex: 0,
      confirm: null,
      progressNote: "已加入队列",
    };
    (task as DesktopTask & { params?: unknown }).params = input.params;

    // 草稿类任务的内容幂等键（A7：重复请求只处理一次）
    if (kind === "wechat_draft") {
      const key = draftDedupeKey(
        buildDraft({
          contact: String(input.params.contact || ""),
          text: String(input.params.text || ""),
          images: (input.params.images as string[]) || [],
        }).payload
      );
      if (this.dedupe.has(key)) {
        task.status = "failed";
        task.error = "相同内容的草稿刚刚已生成过（幂等去重），未重复处理。";
        task.progressNote = "已去重";
      } else {
        this.dedupe.add(key);
      }
    }

    this.tasks.set(taskId, task);
    this.order.push(taskId);
    if (task.status === "queued") this.queue.push(taskId);
    this.persist();
    this.emitEvent(task, "created", "任务已创建");
    safetyManager.audit("task_created", { taskId, kind, goal: goal.slice(0, 120), targetApp });
    this.pump();
    return task;
  }

  private buildSteps(kind: TaskKind, params: Record<string, unknown>): TaskStep[] {
    const mk = (title: string, verify: string): TaskStep => ({
      stepId: `s_${Math.random().toString(36).slice(2, 8)}`,
      title,
      status: "pending",
      verify,
    });
    switch (kind) {
      case "browser_research":
        return [
          mk("打开浏览器并执行搜索", "浏览器窗口出现且加载了搜索结果页"),
          mk("提取搜索结果链接", "至少拿到 2 个可访问的结果 URL"),
          mk("逐个读取页面并记录来源", "每个关键结论对应实际读取的页面（标题+URL）"),
          mk("整理比较与下一步计划", "摘要仅基于已读取内容，标注来源"),
        ];
      case "coding_agent": {
        const repo = String(params.repoUrl || "").trim();
        return [
          mk("定位/启动目标 Agent 窗口", "窗口出现且获得前台焦点"),
          mk("输入任务指令并提交", `指令中包含「${repo || "目标仓库"}」且提交动作已执行`),
          mk("验证指令确实提交", "窗口文本中出现刚提交的指令要素"),
          mk("轮询观察进度直至完成", "命中档案的完成判据（或人工接管）"),
          mk("读取报告并保存产物", "报告全文已落盘，摘要可读"),
        ];
      }
      case "wechat_draft":
        return [
          mk("核验图片文件与输入", "图片存在且为常见格式；联系人/正文非空"),
          mk("定位微信窗口并核对会话", "窗口文本中出现目标联系人（无法识别则转人工核对）"),
          mk("生成草稿并等待用户确认", "面板展示联系人/正文/图片清单，等待确认"),
        ];
      default:
        return [mk("执行任务", "完成")];
    }
  }

  /* ---------------- 用户操作入口 ---------------- */

  /** 继续（waiting_user → queued），不自动重放副作用步骤（从上一步断点继续） */
  resume(taskId: string): { ok: boolean; reason?: string } {
    const t = this.tasks.get(taskId);
    if (!t) return { ok: false, reason: "任务不存在" };
    if (t.status !== "waiting_user") return { ok: false, reason: `任务当前状态为 ${t.status}，无法继续` };
    this.paused.delete(taskId);
    t.status = "queued";
    t.updatedAt = Date.now();
    t.progressNote = "用户已确认继续，从断点恢复";
    this.queue.push(taskId);
    this.persist();
    this.emitEvent(t, "status", "继续任务");
    this.pump();
    return { ok: true };
  }

  /** 暂停（在下一个步骤边界生效） */
  pause(taskId: string): { ok: boolean; reason?: string } {
    const t = this.tasks.get(taskId);
    if (!t) return { ok: false, reason: "任务不存在" };
    if (t.status !== "running" && t.status !== "queued") return { ok: false, reason: `任务当前状态为 ${t.status}，无法暂停` };
    this.paused.add(taskId);
    if (t.status === "queued") {
      this.queue = this.queue.filter((id) => id !== taskId);
      t.status = "waiting_user";
      t.progressNote = "已暂停（用户操作）";
      this.persist();
      this.emitEvent(t, "status", "已暂停");
    } else {
      t.progressNote = "正在等待当前动作结束后暂停…";
      this.emitEvent(t, "progress", "暂停请求已受理");
    }
    return { ok: true };
  }

  /** 取消（排队任务立即取消；运行中任务在当前不可中断调用结束后收敛） */
  cancel(taskId: string, reason = "用户取消"): { ok: boolean; reason?: string } {
    const t = this.tasks.get(taskId);
    if (!t) return { ok: false, reason: "任务不存在" };
    if (["succeeded", "failed", "cancelled"].includes(t.status)) return { ok: false, reason: "任务已结束" };
    this.cancelled.add(taskId);
    this.queue = this.queue.filter((id) => id !== taskId);
    if (t.status === "running") {
      t.progressNote = `正在等待不可中断调用结束，随后取消（${reason}）`;
      this.emitEvent(t, "progress", t.progressNote);
    } else {
      t.status = "cancelled";
      t.error = reason;
      t.confirm = null;
      t.updatedAt = Date.now();
      this.resolveConfirmWaiter(taskId, { approved: false, note: reason });
      this.persist();
      this.emitEvent(t, "status", reason);
    }
    return { ok: true };
  }

  /** 取消全部（急停/面板「停止所有桌面任务」） */
  cancelAll(reason: string): void {
    for (const id of [...this.queue]) this.cancel(id, reason);
    for (const t of this.tasks.values()) {
      if (t.status === "running") this.cancel(t.taskId, reason);
      else if (t.status === "waiting_user" && t.confirm) {
        t.confirm = null;
        this.resolveConfirmWaiter(t.taskId, { approved: false, note: reason });
      }
    }
  }

  /** 重试失败/取消的任务（步骤全部重置，副作用步骤会重新走确认） */
  retry(taskId: string): { ok: boolean; reason?: string } {
    const t = this.tasks.get(taskId);
    if (!t) return { ok: false, reason: "任务不存在" };
    if (!["failed", "cancelled"].includes(t.status)) return { ok: false, reason: `任务当前状态为 ${t.status}，无法重试` };
    for (const s of t.steps) {
      if (s.status !== "pending") s.status = "pending";
      s.error = undefined;
    }
    t.currentStepIndex = 0;
    t.status = "queued";
    t.error = undefined;
    t.confirm = null;
    t.result = undefined;
    t.updatedAt = Date.now();
    this.cancelled.delete(taskId);
    this.paused.delete(taskId);
    this.queue.push(taskId);
    this.persist();
    this.emitEvent(t, "status", "重新尝试");
    this.pump();
    return { ok: true };
  }

  /** 面板/模型对任务确认的答复 */
  respondConfirm(taskId: string, requestId: string, approved: boolean, note?: string): { ok: boolean; reason?: string } {
    const t = this.tasks.get(taskId);
    if (!t || !t.confirm || t.confirm.requestId !== requestId) return { ok: false, reason: "确认请求不存在或已过期" };
    t.confirm = null;
    t.updatedAt = Date.now();
    safetyManager.audit("task_confirm_responded", { taskId, requestId, approved });
    this.resolveConfirmWaiter(taskId, { approved, note });
    if (!approved) {
      if (t.kind === "wechat_draft") {
        t.status = "cancelled";
        t.error = "用户取消草稿（未发送）";
      } else {
        t.status = "waiting_user";
        t.progressNote = "用户未批准，任务暂停。可在面板继续或取消。";
      }
      this.persist();
      this.emitEvent(t, "status", approved ? "已确认" : "已拒绝");
      return { ok: true };
    }
    // 批准：回到队列从断点继续
    t.status = "queued";
    t.progressNote = "已确认，从断点恢复";
    this.persist();
    this.emitEvent(t, "status", "已确认");
    this.queue.push(taskId);
    this.pump();
    return { ok: true };
  }

  /* ---------------- 调度 ---------------- */

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    const tick = () => {
      if (this.currentTaskId) {
        this.pumping = false;
        return;
      }
      const nextId = this.queue.shift();
      if (!nextId) {
        this.pumping = false;
        return;
      }
      const task = this.tasks.get(nextId);
      if (!task || task.status !== "queued") {
        setImmediate(tick);
        return;
      }
      this.currentTaskId = nextId;
      this.runTask(task)
        .catch((e) => {
          if (!(e instanceof TaskCancelled) && !(e instanceof TaskPaused)) {
            logger.errorCategorized("tool_execution", "TaskRunner", `任务 ${task.taskId} 异常终止：${(e as Error).message}`, {
              handled: true,
              context: { taskId: task.taskId },
            });
            task.status = "failed";
            task.error = (e as Error).message.slice(0, 300);
          }
        })
        .finally(() => {
          this.currentTaskId = null;
          task.updatedAt = Date.now();
          this.persist();
          this.emitEvent(task, "status", "调度器推进");
          setImmediate(tick);
        });
    };
    setImmediate(tick);
  }

  /* ---------------- 步骤执行框架 ---------------- */

  private persist(): void {
    taskStore.saveAll(this.list());
  }

  private emitEvent(task: DesktopTask, change: TaskEvent["change"], message?: string): void {
    const ev: TaskEvent = { task: JSON.parse(JSON.stringify(task)), change, message };
    this.emit("task", ev);
    const win = this.panelGetter?.();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.TASK_EVENT, ev);
    }
  }

  private checkControl(task: DesktopTask): void {
    if (isStopped() || this.cancelled.has(task.taskId)) {
      task.status = "cancelled";
      task.error = isStopped() ? "全局急停" : "用户取消";
      task.confirm = null;
      throw new TaskCancelled(task.error);
    }
    if (this.paused.has(task.taskId)) {
      task.status = "waiting_user";
      task.progressNote = "已暂停（用户操作）";
      throw new TaskPaused();
    }
  }

  private async runStep(
    task: DesktopTask,
    index: number,
    action: string,
    fn: (step: TaskStep) => Promise<{ ok: boolean; observation?: string; error?: string }>
  ): Promise<boolean> {
    const step = task.steps[index];
    if (!step) return true;
    // 断点恢复：已完成步骤不重放（避免重复提交等副作用，A8）
    if (step.status === "done") return true;
    this.checkControl(task);

    step.status = "running";
    step.action = action;
    step.startedAt = Date.now();
    step.error = undefined;
    task.currentStepIndex = index;
    task.status = "running";
    task.updatedAt = Date.now();
    this.emitEvent(task, "step", `开始：${step.title}`);
    safetyManager.audit("task_step_started", { taskId: task.taskId, stepId: step.stepId, title: step.title });

    try {
      const r = await fn(step);
      step.observation = r.observation ?? step.observation;
      if (r.observation) task.lastObservation = r.observation.slice(0, 400);
      if (r.ok) {
        step.status = "done";
        step.finishedAt = Date.now();
        this.emitEvent(task, "step", `完成：${step.title}`);
        return true;
      }
      step.status = "failed";
      step.error = r.error ?? "未通过验证";
      step.finishedAt = Date.now();
      task.status = "failed";
      task.error = `${step.title}：${step.error}`;
      this.emitEvent(task, "status", task.error);
      safetyManager.audit("task_step_failed", { taskId: task.taskId, stepId: step.stepId, error: step.error.slice(0, 200) });
      throw new TaskCancelled(task.error); // 视为任务终态（失败）
    } catch (e) {
      if (e instanceof TaskCancelled || e instanceof TaskPaused) throw e;
      step.status = "failed";
      step.error = (e as Error).message.slice(0, 300);
      step.finishedAt = Date.now();
      task.status = "failed";
      task.error = `${step.title}：${step.error}`;
      this.emitEvent(task, "status", task.error);
      throw new TaskCancelled(task.error);
    }
  }

  /** 任务级等待用户（草稿确认 / 人工接管）。无超时（项目书：确认类等待不设时限） */
  private async waitForUser(task: DesktopTask, confirm: TaskConfirmRequest): Promise<{ approved: boolean; note?: string }> {
    task.confirm = confirm;
    task.status = "waiting_user";
    task.updatedAt = Date.now();
    this.persist();
    this.emitEvent(task, "confirm", confirm.title);
    const r = await new Promise<{ approved: boolean; note?: string }>((resolve) => {
      this.confirmWaiters.set(task.taskId, { resolve });
    });
    this.confirmWaiters.delete(task.taskId);
    task.confirm = null;
    this.checkControl(task);
    return r;
  }

  private resolveConfirmWaiter(taskId: string, result: { approved: boolean; note?: string }): void {
    const w = this.confirmWaiters.get(taskId);
    if (w) {
      this.confirmWaiters.delete(taskId);
      w.resolve(result);
    }
  }

  /** 幂等守卫：同一会话内相同副作用动作只执行一次 */
  private idempotencyGuard(key: string): boolean {
    if (this.executedActions.has(key)) return false;
    this.executedActions.add(key);
    return true;
  }

  /* ---------------- 任务主循环 ---------------- */

  private async runTask(task: DesktopTask): Promise<void> {
    const params = ((task as DesktopTask & { params?: Record<string, unknown> }).params || {}) as Record<string, unknown>;
    logger.info(`[TaskRunner] 任务 ${task.taskId}（${task.kind}）开始执行`);
    try {
      switch (task.kind) {
        case "browser_research":
          await this.flowBrowserResearch(task, params);
          break;
        case "coding_agent":
          await this.flowCodingAgent(task, params);
          break;
        case "wechat_draft":
          await this.flowWechatDraft(task, params);
          break;
        default:
          task.status = "failed";
          task.error = `未知任务类型 ${task.kind}`;
      }
    } catch (e) {
      if (e instanceof TaskPaused) {
        // 暂停：状态已在 checkControl 中置好
        this.emitEvent(task, "status", "已暂停");
        return;
      }
      if (e instanceof TaskCancelled) {
        this.emitEvent(task, "status", task.error || "已终止");
        return;
      }
      throw e;
    }
  }

  private succeed(task: DesktopTask, summary: string, artifacts: string[]): void {
    task.status = "succeeded";
    task.result = { summary: summary.slice(0, 2000), artifacts };
    task.updatedAt = Date.now();
    task.progressNote = "任务完成";
    this.emitEvent(task, "result", "任务完成");
    safetyManager.audit("task_succeeded", { taskId: task.taskId, kind: task.kind, artifacts: artifacts.length });
  }

  /* ---------------- 流程一：浏览器搜索与整理 ---------------- */

  private async flowBrowserResearch(task: DesktopTask, params: Record<string, unknown>): Promise<void> {
    const query = String(params.query || "").trim() || task.goal;
    const engine = String(params.engine || "bing").toLowerCase();
    const wantCount = Math.max(2, Math.min(5, Number(params.count) || 3));

    // 步骤 1：打开可见浏览器窗口并搜索
    await this.runStep(task, 0, `在浏览器中搜索「${query}」`, async (step) => {
      const base = engine === "baidu" ? "https://www.baidu.com/s?wd=" : engine === "google" ? "https://www.google.com/search?q=" : "https://www.bing.com/search?q=";
      const url = base + encodeURIComponent(query);
      const launched = await desktopDriver.launchByName("浏览器", url);
      let observation = "";
      if (launched) {
        observation = `已用「${launched}」打开搜索结果页（可见窗口）`;
      } else {
        // 兜底：系统默认关联打开
        await desktopDriver.ps(`Start-Process '${url.replace(/'/g, "''")}' -ErrorAction Stop; 'ok'`, 15_000);
        observation = "已用系统默认浏览器打开搜索结果页";
      }
      await new Promise((r) => setTimeout(r, 2500));
      const wins = await desktopDriver.listWindows();
      const browser = wins.find((w) => ["msedge", "chrome", "firefox", "browser"].includes(w.processName));
      if (!browser) return { ok: false, error: "浏览器窗口未出现，无法确认搜索已执行", observation };
      step.observation = `${observation}；窗口：${browser.processName}「${browser.title.slice(0, 60)}」`;
      return { ok: true, observation: step.observation };
    });

    // 步骤 2：提取结果链接（抓取搜索引擎结果页 HTML，比 UIA 文本更稳定）
    let links: Array<{ url: string; title: string }> = [];
    await this.runStep(task, 1, "提取搜索结果链接", async () => {
      const searchUrl =
        engine === "baidu"
          ? `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`
          : engine === "google"
            ? `https://www.google.com/search?q=${encodeURIComponent(query)}`
            : `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
      const html = await this.fetchText(searchUrl);
      links = this.parseSearchResults(engine, html).slice(0, wantCount * 2);
      taskArtifacts.saveJson(task.taskId, "search-results.json", `搜索结果链接（${query}）`, links);
      if (links.length < 2) {
        return { ok: false, error: `只解析到 ${links.length} 个结果链接（<2），无法完成可靠的资料读取`, observation: `解析到 ${links.length} 个链接` };
      }
      return { ok: true, observation: `解析到 ${links.length} 个结果链接，已存为 search-results.json` };
    });

    // 步骤 3：逐页读取（≥2 页），记录标题/URL/正文摘录 —— 不编造
    const pages: Array<{ url: string; title: string; excerpt: string }> = [];
    await this.runStep(task, 2, `读取前 ${wantCount} 个页面并记录来源`, async () => {
      // 断点恢复：从产物重建链接清单
      if (!links.length) {
        const pg = taskArtifacts.readPage(task.taskId, "search-results.json", 1, 50_000);
        if (pg) {
          try {
            links = JSON.parse(pg.content.split("\n").filter((l) => !l.startsWith("# ")).join("\n"));
          } catch {
            /* ignore */
          }
        }
      }
      let readOk = 0;
      const errors: string[] = [];
      for (const link of links) {
        if (readOk >= wantCount) break;
        try {
          const { text, finalUrl, title } = await this.fetchPage(link.url);
          const excerpt = text.slice(0, 1200);
          pages.push({ url: finalUrl, title: title || link.title, excerpt });
          taskArtifacts.saveText(task.taskId, `page-${readOk + 1}.txt`, title || link.title, text, finalUrl);
          readOk += 1;
        } catch (e) {
          errors.push(`${link.url}: ${(e as Error).message.slice(0, 80)}`);
        }
      }
      const obs = `成功读取 ${readOk} 页；失败 ${errors.length}（${errors.slice(0, 2).join("；")}）`;
      if (readOk < 2) return { ok: false, error: `只成功读取 ${readOk} 页（<2），按项目书要求不得编造摘要`, observation: obs };
      return { ok: true, observation: obs };
    });

    // 步骤 4：整理比较（只基于已读内容摘录）
    await this.runStep(task, 3, "整理比较与下一步计划", async () => {
      // 断点恢复：从产物重建已读页面（page-N.txt），避免重复抓取
      if (!pages.length) {
        const infos = taskArtifacts.list(task.taskId).filter((a) => /^page-\d+\.txt$/.test(a.file));
        for (const info of infos) {
          const pg = taskArtifacts.readPage(task.taskId, info.file, 1, 50_000);
          if (!pg) continue;
          const body = pg.content.split("\n").filter((l) => !l.startsWith("# ")).join("\n").trim();
          pages.push({ url: info.source || "", title: info.title, excerpt: body.slice(0, 1200) });
        }
      }
      const lines: string[] = [`# 「${query}」资料整理（仅基于实际读取的页面）`, ""];
      pages.forEach((p, i) => {
        lines.push(`## 来源 ${i + 1}：《${p.title}》`);
        lines.push(`URL: ${p.url}`);
        lines.push(`原文摘录: ${p.excerpt.replace(/\s+/g, " ").slice(0, 300)}…`);
        lines.push("");
      });
      lines.push("说明：以上为各页面原文摘录与来源清单；下一步建议需结合这些内容由助手与用户确认。");
      const summary = lines.join("\n");
      const file = taskArtifacts.saveText(task.taskId, "summary.md", `「${query}」整理结果`, summary);
      this.succeed(
        task,
        `已读取 ${pages.length} 个页面并生成整理结果（含来源 URL 与原文摘录）。完整内容见任务产物 summary.md。`,
        [file]
      );
      return { ok: true, observation: `整理完成：${pages.length} 个来源` };
    });
  }

  /* ---------------- 流程二：指挥编码 Agent ---------------- */

  private async flowCodingAgent(task: DesktopTask, params: Record<string, unknown>): Promise<void> {
    const repoUrl = String(params.repoUrl || "").trim();
    const instruction = String(params.instruction || "分析这个仓库并给出改进规划").trim();
    let profile = pickAgentProfile(String(params.profileId || "") || undefined);

    // 断点恢复：从暂停/重启恢复时，尽量把目标窗口句柄找回来
    let win: WindowInfo | null = null;
    if (task.currentStepIndex > 0 && profileConfigured(profile)) {
      win = await desktopDriver.findWindow(profile);
      if (win) await desktopDriver.focusWindow(win).catch(() => false);
    }

    // 步骤 1：定位/启动目标窗口
    await this.runStep(task, 0, "定位/启动目标 Agent 窗口", async (step) => {
      if (!profileConfigured(profile)) {
        const r = await this.waitForUser(task, {
          requestId: `tk_${Date.now().toString(36)}`,
          kind: "takeover",
          title: "需要先配置编码 Agent",
          detail:
            "尚未配置可用的编码 Agent 目标窗口。请在「设置 → 桌面任务与 Agent」中选择目标软件的进程名或窗口标题关键字并启用，然后回来点击继续。" +
            "（Jarvis 不限定也不内置某个 Agent 产品；目标是操作你桌面上看得见的那个软件。）",
        });
        if (!r.approved) return { ok: false, error: "用户未配置目标 Agent，任务终止" };
        profile = pickAgentProfile(String(params.profileId || "") || undefined);
        if (!profileConfigured(profile)) return { ok: false, error: "仍未找到可用的 Agent 档案" };
      }
      const p = profile as AppProfile;
      win = await desktopDriver.findWindow(p);
      if (!win && p.launch) {
        const launchedName = p.launch.kind === "app" ? await desktopDriver.launchByName(p.launch.value) : null;
        if (p.launch.kind === "url") {
          await desktopDriver.ps(`Start-Process '${p.launch.value.replace(/'/g, "''")}'`, 15_000).catch(() => "");
        }
        if (launchedName || p.launch.kind === "url") {
          for (let i = 0; i < 10 && !win; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            win = await desktopDriver.findWindow(p);
          }
        }
      }
      if (!win) return { ok: false, error: `未找到匹配窗口（进程: ${p.processNames.join(",") || "无"} / 标题含: ${p.titleIncludes.join(",") || "无"}）` };
      const focused = await desktopDriver.focusWindow(win);
      if (!focused) return { ok: false, error: `窗口「${(win as WindowInfo).title.slice(0, 60)}」无法聚焦` };
      step.observation = `目标窗口：${(win as WindowInfo).processName}「${(win as WindowInfo).title.slice(0, 60)}」（hwnd=${(win as WindowInfo).hwnd}）`;
      return { ok: true, observation: step.observation };
    });

    // 步骤 2：输入指令并提交（幂等：重试恢复时不会重复提交）
    const taskText = `请分析这个仓库：${repoUrl || task.goal}\n要求：${instruction}\n（只做分析与规划，不要修改代码，不要提交仓库。）`;
    await this.runStep(task, 1, "输入任务指令并提交", async (step) => {
      if (!this.idempotencyGuard(`submit:${task.taskId}`)) {
        step.observation = "该提交动作此前已执行过（幂等守卫），跳过重复提交";
        return { ok: true, observation: step.observation };
      }
      const w = win as WindowInfo | null;
      if (!w) return { ok: false, error: "目标窗口句柄丢失" };
      await desktopDriver.focusWindow(w);
      const typed = await desktopDriver.typeIntoWindow(w, taskText);
      if (!typed.ok) return { ok: false, error: `输入失败：${typed.output.slice(0, 160)}` };
      const p = profile as AppProfile;
      const submitKeys = p.submitKeys || "enter";
      const submitted = await desktopDriver.pressKeysForWindow(w, submitKeys);
      if (!submitted.ok) return { ok: false, error: `提交失败：${submitted.output.slice(0, 160)}` };
      step.observation = `已向「${w.title.slice(0, 60)}」输入 ${taskText.length} 字符并按 ${submitKeys} 提交`;
      return { ok: true, observation: step.observation };
    });

    // 步骤 3：验证提交（UIA 快照包含指令要素；无 UIA 时转人工确认）
    await this.runStep(task, 2, "验证指令确实提交", async (step) => {
      const w = win as WindowInfo | null;
      if (!w) return { ok: false, error: "目标窗口句柄丢失" };
      const snap = await desktopDriver.snapshotText();
      if (snap) {
        const marker = repoUrl ? repoUrl : taskText.slice(0, 24);
        const hit = snap.includes(marker) || snap.includes(instruction.slice(0, 24));
        step.observation = `UIA 快照 ${snap.length} 字符，指令要素${hit ? "已" : "未"}出现`;
        if (hit) return { ok: true, observation: step.observation };
        return { ok: false, error: "窗口文本中未找到刚提交的指令要素，可能未提交成功", observation: step.observation };
      }
      const r = await this.waitForUser(task, {
        requestId: `tk_${Date.now().toString(36)}`,
        kind: "takeover",
        title: "请人工确认指令已提交",
        detail: `已向「${w.title.slice(0, 60)}」输入指令并按提交键，但当前没有 UIA 快照通道（未启用 Windows-MCP），无法自动验证提交结果。请在目标软件中确认任务已开始，然后点击继续。`,
      });
      return r.approved ? { ok: true, observation: "用户人工确认指令已提交" } : { ok: false, error: "用户确认指令未提交" };
    });

    // 步骤 4：轮询进度（分段等待，不靠一次阻塞调用）
    let finalSnapshot = "";
    await this.runStep(task, 3, "轮询观察进度直至完成", async (step) => {
      const p = profile as AppProfile;
      const intervalMs = 15_000;
      const maxPolls = 80; // 80 * 15s = 20 分钟
      let noMarkerStreak = 0;
      for (let i = 0; i < maxPolls; i++) {
        this.checkControl(task);
        await new Promise((r) => setTimeout(r, intervalMs));
        this.checkControl(task);
        const snap = (await desktopDriver.snapshotText()) || "";
        const done = p.doneMarkers.length ? p.doneMarkers.some((m) => snap.includes(m)) : false;
        const running = p.runningMarkers.length ? p.runningMarkers.some((m) => snap.includes(m)) : false;
        if (snap) finalSnapshot = snap;
        task.lastObservation = `第 ${i + 1} 次轮询：快照 ${snap.length} 字符，done=${done} running=${running}`;
        task.progressNote = task.lastObservation;
        this.emitEvent(task, "progress", task.progressNote);
        if (done) return { ok: true, observation: `第 ${i + 1} 次轮询命中完成判据` };
        if (!running && !done) noMarkerStreak += 1;
        else noMarkerStreak = 0;
        if (noMarkerStreak >= 4) {
          const r = await this.waitForUser(task, {
            requestId: `tk_${Date.now().toString(36)}`,
            kind: "takeover",
            title: "Agent 状态需要人工判断",
            detail:
              "连续 4 次轮询都没有命中运行中/完成判据。Agent 可能弹出了自己的权限提示（这类提示必须由你处理，Jarvis 不会代点）或已停止。请人工查看目标软件后点击继续（继续轮询）或取消任务。",
          });
          if (!r.approved) return { ok: false, error: "用户在人工核对后取消了任务" };
          noMarkerStreak = 0;
        }
      }
      return { ok: false, error: `轮询 ${maxPolls} 次后仍未命中完成判据` };
    });

    // 步骤 5：读取报告并保存
    await this.runStep(task, 4, "读取报告并保存产物", async (step) => {
      const p = profile as AppProfile;
      let report = "";
      if (finalSnapshot) {
        report = finalSnapshot.slice(-20_000);
      }
      if (p.resultExtract === "clipboard" || !report) {
        const w = win as WindowInfo | null;
        if (w) {
          await desktopDriver.focusWindow(w);
          await desktopDriver.pressKeysForWindow(w, "ctrl+a");
          await desktopDriver.pressKeysForWindow(w, "ctrl+c");
          report = (await desktopDriver.readClipboard()) || report;
        }
      }
      if (!report.trim()) return { ok: false, error: "未能提取到 Agent 报告内容（快照与剪贴板均为空）" };
      const file = taskArtifacts.saveText(task.taskId, "agent-report.txt", "编码 Agent 报告", report, `窗口:${(win as WindowInfo)?.title.slice(0, 60)}`);
      const safe = sanitizeToolOutput(report.slice(0, 800), "coding-agent");
      this.succeed(
        task,
        `Agent 报告已读取并保存（${report.length} 字符，未因 90 秒调用超时或 8000 字符截断丢失）。摘要开头：${safe.slice(0, 600)}`,
        [file]
      );
      return { ok: true, observation: `报告 ${report.length} 字符已落盘` };
    });
  }

  /* ---------------- 流程三：微信草稿（不发送） ---------------- */

  private async flowWechatDraft(task: DesktopTask, params: Record<string, unknown>): Promise<void> {
    const contact = String(params.contact || "").trim();
    const text = String(params.text || "");
    const images = (params.images as string[]) || [];

    // 步骤 1：核验
    let draft: WechatDraftPayload | null = null;
    await this.runStep(task, 0, "核验图片文件与输入", async () => {
      const r = buildDraft({ contact, text, images });
      draft = r.payload;
      if (!r.ok) return { ok: false, error: r.errors.join("；") };
      const obs = `联系人「${contact}」；正文 ${text.length} 字；图片 ${r.payload.images.length}/${images.length} 可用；警告 ${r.payload.warnings.length} 条`;
      taskArtifacts.saveJson(task.taskId, "draft.json", "微信草稿（待人工确认）", r.payload);
      return { ok: true, observation: obs };
    });

    // 步骤 2：定位微信窗口并核对会话（只读观察 + 定位，绝不执行选择/粘贴）
    await this.runStep(task, 1, "定位微信窗口并核对会话", async (step) => {
      const p = pickAgentProfile("wechat");
      let win: WindowInfo | null = p ? await desktopDriver.findWindow(p) : null;
      if (!win) {
        step.observation = "未找到微信窗口；草稿仍可生成，由你打开微信后手动发送";
        task.progressNote = step.observation;
        return { ok: true, observation: step.observation };
      }
      await desktopDriver.focusWindow(win);
      await new Promise((r) => setTimeout(r, 1200));
      const snap = await desktopDriver.snapshotText();
      if (snap) {
        const hit = snap.includes(contact);
        step.observation = `微信窗口「${win.title.slice(0, 50)}」快照 ${snap.length} 字符，联系人${hit ? "已" : "未"}在会话文本中出现`;
        if (!hit) {
          step.observation += "（将以草稿确认界面人工核对为准）";
        }
        return { ok: true, observation: step.observation };
      }
      // UIA 不可用：转人工核对（不得盲操作）
      const r = await this.waitForUser(task, {
        requestId: `tk_${Date.now().toString(36)}`,
        kind: "takeover",
        title: "请人工核对微信会话",
        detail: `无法通过 UIA 读取微信窗口文本来核对联系人「${contact}」。请你在微信中打开与该联系人的会话并确认名称正确，然后点击继续（草稿仍在 Jarvis 面板中确认，不会自动发送）。`,
      });
      return r.approved
        ? { ok: true, observation: "用户人工核对会话通过" }
        : { ok: false, error: "用户取消（会话未核对）" };
    });

    // 步骤 3：草稿确认（终点即 Jarvis 面板；确认后仍由用户手动发送）
    await this.runStep(task, 2, "生成草稿并等待用户确认", async (step) => {
      // 断点恢复时从参数重建（buildDraft 确定性），避免恢复后草稿数据缺失
      const rebuilt = buildDraft({ contact, text, images });
      const d = (draft as WechatDraftPayload | null) ?? rebuilt.payload;
      if (!d) return { ok: false, error: "草稿数据缺失" };
      const r = await this.waitForUser(task, {
        requestId: `tk_${Date.now().toString(36)}`,
        kind: "draft_review",
        title: "微信草稿确认（不会自动发送）",
        detail:
          "请核对以下内容。确认后草稿保存为产物，发送需要你自己在微信中操作 —— 自动发送/自动回复尚未开放（平台接入核查未完成）。",
        payload: d,
      });
      if (!r.approved) return { ok: false, error: "用户取消了草稿（未发送）" };
      const file = taskArtifacts.saveJson(task.taskId, "draft-confirmed.json", "已确认的微信草稿（人工发送）", d);
      this.succeed(task, `草稿已确认并保存。请在微信中手动发送给「${d.contact}」（自动发送尚未开放）。`, [file]);
      return { ok: true, observation: "草稿已确认并保存" };
    });
  }

  /* ---------------- 抓取辅助 ---------------- */

  private async fetchText(url: string, timeoutMs = 20_000): Promise<string> {
    const f = (globalThis as unknown as { fetch?: (u: string, i?: unknown) => Promise<any> }).fetch;
    if (typeof f !== "function") throw new Error("当前运行环境不支持 fetch");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await f(url, { signal: ctrl.signal, headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Jarvis/1.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchPage(url: string): Promise<{ text: string; finalUrl: string; title: string }> {
    const html = await this.fetchText(url);
    const finalUrl = url;
    const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = t ? t[1].trim().slice(0, 200) : "";
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) throw new Error("页面没有可提取的文本（可能是纯前端渲染或需要登录）");
    return { text: text.slice(0, 50_000), finalUrl, title };
  }

  /** 从搜索引擎结果页 HTML 提取结果链接 */
  private parseSearchResults(engine: string, html: string): Array<{ url: string; title: string }> {
    const out: Array<{ url: string; title: string }> = [];
    const seen = new Set<string>();
    const push = (url: string, title: string) => {
      try {
        const u = new URL(url);
        if (!/^https?:$/.test(u.protocol)) return;
        if (u.hostname.includes("bing.com") || u.hostname.includes("baidu.com") || u.hostname.includes("google.com")) {
          if (!/\/ck\/a$/.test(u.pathname)) return; // 排除引擎内部链接（bing 跳转链接除外）
        }
        if (seen.has(u.href)) return;
        seen.add(u.href);
        out.push({ url: u.href, title: title.replace(/<[^>]+>/g, "").trim().slice(0, 160) });
      } catch {
        /* ignore */
      }
    };
    if (engine === "baidu") {
      const re = /<h3[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) && out.length < 20) push(m[1], m[2]);
    } else if (engine === "google") {
      const re = /<a[^>]+href="\/url\?q=(https?[^&"]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) && out.length < 20) push(decodeURIComponent(m[1]), m[2]);
    } else {
      // bing：<li class="b_algo"> … <h2><a href="…">
      const re = /<li class="b_algo"[\s\S]*?<h2>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) && out.length < 20) push(m[1], m[2]);
      if (!out.length) {
        const re2 = /<h2>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        let m2: RegExpExecArray | null;
        while ((m2 = re2.exec(html)) && out.length < 20) push(m2[1], m2[2]);
      }
    }
    return out;
  }
}

export const taskRunner = new TaskRunner();
