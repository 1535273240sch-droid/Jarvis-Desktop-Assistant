import { EventEmitter } from "node:events";
import { spawn, spawnSync, ChildProcess } from "node:child_process";
import { logger } from "./logger";
import { safetyManager } from "./safety";
import { configManager } from "./config";
import { isStopped, onStop } from "./emergency-stop";
import { sanitizeToolOutput } from "./prompt-guard";
import type { McpServerConfig, SecurityConfirmRequest } from "../common/types";

/**
 * 外部 MCP 客户端（stdio 传输）。
 *
 * 让 Jarvis 能接上任意符合 MCP 协议的外部工具服务，例如：
 *   { "name":"filesystem", "command":"npx", "args":["-y","@modelcontextprotocol/server-filesystem","C:\\data"] }
 *   { "name":"github",     "command":"npx", "args":["-y","@modelcontextprotocol/server-github"],
 *     "env":{"GITHUB_PERSONAL_ACCESS_TOKEN":"…"} }
 *
 * 与内置 DesktopCommander 的区别：
 *   - 内置那份是「本机桌面操作」专用，工具名走白名单裁剪；
 *   - 这里面向用户自定义扩展，但**不再无脑全量暴露**：工具经 ActionPolicy
 *     分类后按能力清单管控，无法分类的写入类工具默认请求确认（项目书 P0）。
 *
 * 安全（项目书 P0/P1）：
 *   - external_send / account_or_payment / unknown 一律独立确认，
 *     不受 confirmHighRisk 全局开关豁免；
 *   - 急停后新调用直接拒绝；正在等待的调用被取消等待（不产生新动作）；
 *   - 工具结果按「不可信外部内容」包裹回注，防止网页/聊天文字提升为指令；
 *   - 审计参数经 log-redact 脱敏（在 safetyManager 内统一执行）。
 */

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingCall {
  resolve: (r: JsonRpcResponse) => void;
  timer: NodeJS.Timeout;
  method: string;
}

interface ServerRuntime {
  config: McpServerConfig;
  proc: ChildProcess | null;
  nextId: number;
  pending: Map<number, PendingCall>;
  stdoutBuffer: string;
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  ready: boolean;
  lastError?: string;
  restartTimer?: NodeJS.Timeout;
}

/** 把外部工具名规范化：加服务器前缀，并过滤 MCP/模型不允许的字符 */
export function prefixToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  const full = `${clean(server)}__${clean(tool)}`;
  return full.length > 64 ? full.slice(0, 64) : full;
}

class ExternalMcpManager extends EventEmitter {
  private servers = new Map<string, ServerRuntime>();
  // [supervisor patch] 每个服务器的待执行重启定时器与退避计数（跨 rt 重建保持）
  private respawnTimers = new Map<string, NodeJS.Timeout>();
  private respawnAttempts = new Map<string, number>();

  /** [supervisor patch] 崩溃自动重启：指数退避 2s/4s/8s/…/30s */
  private scheduleRespawn(cfg: McpServerConfig, attempts: number): void {
    const key = cfg.name;
    this.respawnAttempts.set(key, attempts);
    const prev = this.respawnTimers.get(key);
    if (prev) clearTimeout(prev);
    const delayMs = Math.min(30000, 2000 * Math.pow(2, Math.max(0, attempts - 1)));
    logger.info(`[ExtMCP Supervisor] 「${key}」将在 ${delayMs}ms 后自动重启（第 ${attempts} 次）`);
    const t = setTimeout(() => {
      this.respawnTimers.delete(key);
      const cur = this.servers.get(key);
      if (!cur || cur.proc || cur.ready) return; // stopAll 已清理，或 startAll 已重建正常实例
      this.startOne(cfg)
        .then((ok) => {
          if (ok) {
            this.respawnAttempts.delete(key);
            logger.info(`[ExtMCP Supervisor] 「${key}」已自动重启并重新发现工具`);
            this.emit("tools");
          } else {
            const cur2 = this.servers.get(key);
            if (cur2 && !cur2.proc && !cur2.ready) this.scheduleRespawn(cfg, attempts + 1);
          }
        })
        .catch(() => this.scheduleRespawn(cfg, attempts + 1));
    }, delayMs);
    this.respawnTimers.set(key, t);
  }

  /** 当前已就绪服务器的全部工具（含前缀名，可直接下发给模型）。
   *  filter：按能力过滤（任务运行中只暴露该任务需要的工具，项目书 P1） */
  toModelTools(filter?: (full: { server: string; tool: string; name: string }) => boolean): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const rt of this.servers.values()) {
      if (!rt.ready) continue;
      for (const t of rt.tools) {
        const full = prefixToolName(rt.config.name, t.name);
        if (filter && !filter({ server: rt.config.name, tool: t.name, name: full })) continue;
        out.push({
          type: "function",
          function: {
            name: full,
            description: (t.description || `${rt.config.name} 的 ${t.name} 工具`).slice(0, 1024),
            parameters: (t.inputSchema as Record<string, unknown>) || { type: "object", properties: {} },
          },
        });
      }
    }
    return out;
  }

  /** 名称 -> 服务器/原始工具名 的反查表 */
  resolveTool(fullName: string): { rt: ServerRuntime; toolName: string } | null {
    for (const rt of this.servers.values()) {
      for (const t of rt.tools) {
        if (prefixToolName(rt.config.name, t.name) === fullName) return { rt, toolName: t.name };
      }
    }
    return null;
  }

  /** 是否归外部 MCP 管（用于 orchestrator 分派） */
  owns(fullName: string): boolean {
    return this.resolveTool(fullName) !== null;
  }

  /** 指定服务器是否有某个工具（用于桌面驱动探测 Windows-MCP 能力） */
  hasTool(serverName: string, toolName: string): boolean {
    const rt = this.servers.get(serverName);
    if (!rt || !rt.ready) return false;
    return rt.tools.some((t) => t.name === toolName);
  }

  /** 拼出某服务器工具的前缀全名（不存在时返回 null） */
  fullToolName(serverName: string, toolName: string): string | null {
    const rt = this.servers.get(serverName);
    if (!rt || !rt.ready) return null;
    return rt.tools.some((t) => t.name === toolName) ? prefixToolName(serverName, toolName) : null;
  }

  status(): Array<{ name: string; ready: boolean; toolCount: number; error?: string; command: string }> {
    return [...this.servers.values()].map((rt) => ({
      name: rt.config.name,
      ready: rt.ready,
      toolCount: rt.tools.length,
      error: rt.lastError,
      command: `${rt.config.command} ${(rt.config.args || []).join(" ")}`.trim(),
    }));
  }

  /** 按配置启动全部外部服务器（可重复调用，会先停掉旧的） */
  async startAll(): Promise<{ started: number; failed: number }> {
    this.stopAll();
    const cfgs = (configManager.get().mcpServers || []).filter((c) => c && c.enabled !== false && c.name && c.command);
    if (!cfgs.length) {
      logger.info("[ExtMCP] 未配置外部 MCP 服务器");
      return { started: 0, failed: 0 };
    }
    let started = 0;
    let failed = 0;
    for (const c of cfgs) {
      const ok = await this.startOne(c);
      if (ok) started += 1;
      else failed += 1;
    }
    logger.info(`[ExtMCP] 外部 MCP 启动完成：成功 ${started} 个，失败 ${failed} 个`);
    if (started) this.emit("tools");
    return { started, failed };
  }

  private async startOne(cfg: McpServerConfig): Promise<boolean> {
    const rt: ServerRuntime = {
      config: cfg,
      proc: null,
      nextId: 1,
      pending: new Map(),
      stdoutBuffer: "",
      tools: [],
      ready: false,
    };
    this.servers.set(cfg.name, rt);

    try {
      rt.proc = spawn(cfg.command, cfg.args || [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...(cfg.env || {}) },
        shell: process.platform === "win32", // npx/npm 这类 .cmd 需要 shell
      });
    } catch (e) {
      rt.lastError = `启动失败：${(e as Error).message}`;
      logger.errorCategorized("tool_unavailable", "ExtMCP", `外部 MCP「${cfg.name}」${rt.lastError}`, {
        handled: true,
        context: { command: cfg.command, args: cfg.args },
      });
      return false;
    }

    rt.proc.stdout?.on("data", (chunk: Buffer) => this.onStdout(rt, chunk));
    rt.proc.stderr?.on("data", (chunk: Buffer) => {
      const s = chunk.toString().trim();
      if (s) logger.warn(`[ExtMCP:${cfg.name}] ${s.slice(0, 300)}`);
    });
    rt.proc.on("exit", (code, signal) => {
      logger.warn(`[ExtMCP] 「${cfg.name}」子进程退出 code=${code} signal=${signal}`);
      rt.ready = false;
      rt.proc = null;
      for (const [, p] of rt.pending) {
        clearTimeout(p.timer);
        p.resolve({ jsonrpc: "2.0", id: -1, error: { code: -32000, message: "外部 MCP 子进程已退出" } });
      }
      rt.pending.clear();
      // [supervisor patch] 崩溃自动重启；stopAll 清理后 / startAll 重建后自动失效
      if (this.servers.get(cfg.name) === rt) {
        const attempts = (this.respawnAttempts.get(cfg.name) || 0) + 1;
        this.scheduleRespawn(cfg, attempts);
      }
    });    rt.proc.on("error", (err) => {
      rt.lastError = err.message;
      logger.errorCategorized("tool_unavailable", "ExtMCP", `外部 MCP「${cfg.name}」进程错误：${err.message}`, {
        handled: true,
      });
    });

    // 握手
    try {
      const init = await this.rpc(rt, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "jarvis-desktop-assistant", version: "1.0.0" },
      }, 45_000);
      if (init.error) throw new Error(init.error.message);
      this.notify(rt, "notifications/initialized", {});
      rt.ready = true;
    } catch (e) {
      rt.lastError = `初始化失败：${(e as Error).message}`;
      logger.errorCategorized("tool_unavailable", "ExtMCP", `外部 MCP「${cfg.name}」${rt.lastError}`, {
        handled: true,
        context: { command: cfg.command, args: cfg.args },
      });
      return false;
    }

    // 工具发现
    try {
      const list = await this.rpc(rt, "tools/list", {}, 30_000);
      rt.tools = list.result?.tools || [];
      logger.info(`[ExtMCP] 「${cfg.name}」发现 ${rt.tools.length} 个工具：${rt.tools.map((t) => t.name).join(", ")}`);
    } catch (e) {
      rt.lastError = `工具发现失败：${(e as Error).message}`;
      logger.warn(`[ExtMCP] 「${cfg.name}」${rt.lastError}`);
      return false;
    }
    return true;
  }

  stopAll(): void {
    // [supervisor patch] 主动停止时撤销所有待执行的重启计划
    for (const t of this.respawnTimers.values()) clearTimeout(t);
    this.respawnTimers.clear();
    this.respawnAttempts.clear();
    for (const rt of this.servers.values()) {
      if (rt.proc) {
        try {
          if (process.platform === "win32" && rt.proc.pid) {
            // spawn 用了 shell:true，直接子进程是 cmd.exe 壳；proc.kill() 只杀壳，
            // 真正的服务进程（windows-mcp / npx node）会孤儿化残留，必须连进程树一起清。
            // spawnSync 保证 app 完全退出前进程树已终止。
            spawnSync("taskkill", ["/pid", String(rt.proc.pid), "/T", "/F"], { stdio: "ignore" });
          } else {
            rt.proc.kill();
          }
        } catch {
          /* ignore */
        }
        rt.proc = null;
      }
      rt.ready = false;
    }
    this.servers.clear();
  }

  /**
   * 试运行一个配置：临时拉起、握手、列工具，然后立刻关掉。
   * 用于面板里的「测试连接」，避免用户配错了却要开会话才发现。
   */
  async testConfig(cfg: McpServerConfig): Promise<{
    ok: boolean;
    reason?: string;
    serverName?: string;
    version?: string;
    tools?: Array<{ name: string; description?: string }>;
  }> {
    const temp = new ExternalMcpManager();
    try {
      const ok = await temp.startOne({ ...cfg, name: cfg.name || "test" });
      if (!ok) {
        const rt = temp.servers.get(cfg.name || "test");
        return { ok: false, reason: rt?.lastError || "连接失败" };
      }
      const rt = temp.servers.get(cfg.name || "test")!;
      // 已知的是「子进程启动向导的版本」，这里直接回传工具清单即可
      return {
        ok: true,
        serverName: cfg.name,
        tools: rt.tools.map((t) => ({ name: t.name, description: t.description })),
      };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    } finally {
      temp.stopAll();
    }
  }

  /* ---------------- JSON-RPC ---------------- */

  private notify(rt: ServerRuntime, method: string, params: unknown): void {
    if (!rt.proc?.stdin?.writable) return;
    try {
      rt.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    } catch {
      /* ignore */
    }
  }

  private rpc(rt: ServerRuntime, method: string, params: unknown, timeoutMs = 60_000): Promise<JsonRpcResponse> {
    return new Promise((resolve) => {
      if (!rt.proc?.stdin?.writable) {
        resolve({ jsonrpc: "2.0", id: -1, error: { code: -32000, message: "外部 MCP 不可用" } });
        return;
      }
      const id = rt.nextId++;
      const timer = setTimeout(() => {
        rt.pending.delete(id);
        resolve({ jsonrpc: "2.0", id, error: { code: -32001, message: `调用 ${method} 超时（${timeoutMs}ms）` } });
      }, timeoutMs);
      rt.pending.set(id, { resolve, timer, method });
      try {
        rt.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (e) {
        clearTimeout(timer);
        rt.pending.delete(id);
        resolve({ jsonrpc: "2.0", id: -1, error: { code: -32000, message: (e as Error).message } });
      }
    });
  }

  /**
   * 取消全部挂起中的调用（急停时由 onStop 触发）。
   * 单次 stdio 调用无法真正中断子进程内部执行，但等待会立即结束、
   * 结果被丢弃、后续动作被 isStopped 阻断 —— 即「正在等待不可中断调用结束」。
   */
  cancelAllInFlight(reason: string): number {
    let n = 0;
    for (const rt of this.servers.values()) {
      for (const [, p] of rt.pending) {
        clearTimeout(p.timer);
        p.resolve({ jsonrpc: "2.0", id: -1, error: { code: -32002, message: `急停：${reason}，等待已中止` } });
        n += 1;
      }
      rt.pending.clear();
    }
    if (n) logger.warn(`[ExtMCP] 急停：已中止 ${n} 个挂起中的外部 MCP 调用`);
    return n;
  }

  private onStdout(rt: ServerRuntime, chunk: Buffer): void {
    rt.stdoutBuffer += chunk.toString();
    let idx: number;
    while ((idx = rt.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = rt.stdoutBuffer.slice(0, idx).trim();
      rt.stdoutBuffer = rt.stdoutBuffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // 启动横幅等非 JSON 输出
      }
      if (typeof msg.id === "number" && rt.pending.has(msg.id)) {
        const p = rt.pending.get(msg.id)!;
        clearTimeout(p.timer);
        rt.pending.delete(msg.id);
        p.resolve(msg as JsonRpcResponse);
      }
    }
  }

  /* ---------------- 工具调用（ActionPolicy 安全闸门） ---------------- */

  /**
   * 从参数里提取「对外发送」确认所需的通信要素。
   * 收件人/正文/附件清单将完整展示在确认界面（项目书 P0）。
   */
  private extractComm(args: Record<string, unknown>): { recipient: string; body: string; attachments: string[] } | null {
    const rec = args.to ?? args.recipient ?? args.contact ?? args.phone ?? args.会话 ?? args.联系人;
    const body = args.message ?? args.text ?? args.content ?? args.body;
    const files = args.files ?? args.images ?? args.attachments;
    if (rec === undefined && body === undefined && files === undefined) return null;
    return {
      recipient: String(rec ?? "（未指明收件人）"),
      body: typeof body === "string" ? body : body === undefined ? "" : JSON.stringify(body, null, 2),
      attachments: Array.isArray(files) ? files.map((f) => String(f)) : typeof files === "string" ? [files] : [],
    };
  }

  async callTool(
    fullName: string,
    args: Record<string, unknown>,
    opts: { timeoutMs?: number } = {}
  ): Promise<{ ok: boolean; output: string; rejected?: boolean }> {
    const found = this.resolveTool(fullName);
    if (!found) return { ok: false, output: `未找到外部工具 ${fullName}` };
    const { rt, toolName } = found;
    const started = Date.now();

    // 0) 急停：阻断一切新的外部 MCP 动作（A4）
    if (isStopped()) {
      safetyManager.auditToolCall(fullName, args, "rejected", 0, "全局急停生效中");
      return { ok: false, output: "全局急停生效中，已拒绝执行该外部工具。请先在面板解除急停。", rejected: true };
    }

    if (!rt.ready || !rt.proc) {
      return { ok: false, output: `外部 MCP「${rt.config.name}」未就绪：${rt.lastError || "未知原因"}` };
    }

    // 1) ActionPolicy 语义分类（项目书 P0）
    const cls = safetyManager.classifyAction(rt.config.name, toolName, args);

    // 2) 强制独立确认类：对外发送 / 支付账号 / 未知工具 —— 不受 confirmHighRisk 豁免
    if (cls.needsConfirm) {
      const comm = cls.category === "external_send" ? this.extractComm(args) : null;
      const req: SecurityConfirmRequest = {
        requestId: `cfm_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`,
        riskLevel: cls.risk === "critical" ? "critical" : "high",
        actionType: cls.category === "external_send" ? "external_send" : "terminal_command",
        title: `是否允许执行：${rt.config.name} / ${toolName}`,
        target: comm ? `发送给：${comm.recipient}` : JSON.stringify(args).slice(0, 200),
        explanation: `${cls.label}\n\n该动作类型（${cls.category}）必须逐次确认，执行模式开关对此无效。`,
        comm: comm ?? undefined,
      };
      const approved = await safetyManager.requestConfirmation(req);
      if (!approved) {
        safetyManager.auditToolCall(fullName, args, "rejected", Date.now() - started);
        return { ok: false, output: "用户拒绝执行该操作。请勿重试。", rejected: true };
      }
    } else {
      // 3) 其余类别沿用既有的 confirmHighRisk 行为
      const risk = safetyManager.needsConfirmation(toolName, args);
      if (risk.need && configManager.get().confirmHighRisk) {
        const approved = await safetyManager.requestConfirmation({
          requestId: `cfm_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`,
          riskLevel: risk.level,
          actionType: "terminal_command",
          title: `是否允许执行：${rt.config.name} / ${toolName}`,
          target: JSON.stringify(args).slice(0, 200),
          explanation: `${risk.label}\n\n参数：${JSON.stringify(args, null, 2).slice(0, 800)}`,
        });
        if (!approved) {
          safetyManager.auditToolCall(fullName, args, "rejected", Date.now() - started);
          return { ok: false, output: "用户拒绝执行该操作。请勿重试。", rejected: true };
        }
      } else if (risk.need) {
        safetyManager.audit("auto_approved", { toolName: fullName, label: risk.label, source: "external-mcp" });
      }
    }

    // 4) 执行（超时可由任务引擎按步骤收紧；不再固定 90 秒）
    try {
      const res = await this.rpc(rt, "tools/call", { name: toolName, arguments: args }, opts.timeoutMs ?? 90_000);
      const dur = Date.now() - started;
      if (res.error) {
        safetyManager.auditToolCall(fullName, args, "error", dur, res.error.message);
        logger.errorCategorized("tool_execution", "ExtMCP", `外部工具 ${fullName} 报错：${res.error.message}`, {
          tool: fullName,
          handled: true,
          context: { args: JSON.stringify(args).slice(0, 400) },
        });
        return { ok: false, output: `工具执行出错：${res.error.message}` };
      }
      const content = res.result?.content;
      const text = Array.isArray(content)
        ? content.map((c: any) => (typeof c?.text === "string" ? c.text : JSON.stringify(c))).join("\n")
        : typeof res.result === "string"
          ? res.result
          : JSON.stringify(res.result ?? {});
      const isError = Boolean(res.result?.isError);
      safetyManager.auditToolCall(fullName, args, isError ? "failed" : "success", dur, text);
      if (isError) {
        logger.errorCategorized("tool_execution", "ExtMCP", `外部工具 ${fullName} 返回错误：${text.slice(0, 300)}`, {
          tool: fullName,
          handled: true,
        });
      }
      // 5) 工具结果按「不可信外部内容」包裹（网页/聊天/Agent 文字不得提升为指令）
      const safeText = sanitizeToolOutput(text || "", rt.config.name);
      return { ok: !isError, output: safeText || (isError ? "工具返回错误（无详情）" : "执行完成（无输出）") };
    } catch (e) {
      const dur = Date.now() - started;
      safetyManager.auditToolCall(fullName, args, "error", dur, (e as Error).message);
      logger.errorCategorized("tool_execution", "ExtMCP", `外部工具 ${fullName} 异常：${(e as Error).message}`, {
        tool: fullName,
        handled: true,
      });
      return { ok: false, output: `工具调用异常：${(e as Error).message}` };
    }
  }
}

// 急停：中止全部挂起调用（新调用由 callTool 入口 isStopped 阻断）
onStop((reason) => externalMcp.cancelAllInFlight(reason));

export const externalMcp = new ExternalMcpManager();
