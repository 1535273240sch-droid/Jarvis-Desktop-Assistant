import { EventEmitter } from "node:events";
import { spawn, ChildProcess } from "node:child_process";
import { logger } from "./logger";
import { safetyManager } from "./safety";
import { configManager } from "./config";
import type { McpServerConfig } from "../common/types";

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
 *   - 这里面向用户自定义扩展，工具**全量暴露**（用户自己选的服务器自己负责），
 *     但工具名统一加 `<serverName>__` 前缀，避免不同服务器重名互相覆盖。
 *
 * 安全：调用同样经过 safetyManager 的风险评估与审计；高危命令仍会按用户选择的
 * 执行模式（全自动/逐次确认）处理。
 */

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

interface ServerRuntime {
  config: McpServerConfig;
  proc: ChildProcess | null;
  nextId: number;
  pending: Map<number, { resolve: (r: JsonRpcResponse) => void; timer: NodeJS.Timeout }>;
  stdoutBuffer: string;
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  ready: boolean;
  lastError?: string;
}

/** 把外部工具名规范化：加服务器前缀，并过滤 MCP/模型不允许的字符 */
export function prefixToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  const full = `${clean(server)}__${clean(tool)}`;
  return full.length > 64 ? full.slice(0, 64) : full;
}

class ExternalMcpManager extends EventEmitter {
  private servers = new Map<string, ServerRuntime>();

  /** 当前已就绪服务器的全部工具（含前缀名，可直接下发给模型） */
  toModelTools(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const rt of this.servers.values()) {
      if (!rt.ready) continue;
      for (const t of rt.tools) {
        out.push({
          type: "function",
          function: {
            name: prefixToolName(rt.config.name, t.name),
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
    });
    rt.proc.on("error", (err) => {
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
    for (const rt of this.servers.values()) {
      if (rt.proc) {
        try {
          rt.proc.kill();
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
      rt.pending.set(id, { resolve, timer });
      try {
        rt.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (e) {
        clearTimeout(timer);
        rt.pending.delete(id);
        resolve({ jsonrpc: "2.0", id: -1, error: { code: -32000, message: (e as Error).message } });
      }
    });
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

  /* ---------------- 工具调用（含安全闸门） ---------------- */

  async callTool(
    fullName: string,
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; output: string; rejected?: boolean }> {
    const found = this.resolveTool(fullName);
    if (!found) return { ok: false, output: `未找到外部工具 ${fullName}` };
    const { rt, toolName } = found;
    const started = Date.now();

    if (!rt.ready || !rt.proc) {
      return { ok: false, output: `外部 MCP「${rt.config.name}」未就绪：${rt.lastError || "未知原因"}` };
    }

    // 与内置路径一致的风险评估
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

    try {
      const res = await this.rpc(rt, "tools/call", { name: toolName, arguments: args }, 90_000);
      const dur = Date.now() - started;
      if (res.error) {
        safetyManager.auditToolCall(fullName, args, "error", dur, res.error.message);
        // 关键：外部 MCP 的失败也要进分类错误日志，方便排查「指令没做成」
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
      return { ok: !isError, output: text || (isError ? "工具返回错误（无详情）" : "执行完成（无输出）") };
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

export const externalMcp = new ExternalMcpManager();
