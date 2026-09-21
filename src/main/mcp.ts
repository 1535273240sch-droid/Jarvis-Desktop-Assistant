import { EventEmitter } from "node:events";
import * as path from "node:path";
import { spawn, ChildProcess } from "node:child_process";
import { logger } from "./logger";
import { configManager } from "./config";
import { safetyManager } from "./safety";
import { IPC } from "../common/types";
import type { SecurityConfirmRequest } from "../common/types";

/**
 * DesktopCommanderMCP 客户端（stdio 子进程）。
 *
 * 重要事实（已核实，写进架构的硬约束）：
 * - 该 MCP **没有任何截图 / 视觉 / 鼠标 / 键盘工具**。任务书第四阶段的桌面控制与
 *   视觉能力由本项目的 vision.ts（desktopCapturer + 视觉 HTTP）承担，不走 MCP。
 * - 它只提供 终端 / 文件系统 / 文本编辑 / 配置 类工具。
 * - 其 allowedDirectories **不约束终端命令**且可被绕过，故本模块在其之上叠加
 *   应用级安全闸门（safety.ts），对高危命令与敏感工具强制人工确认。
 *
 * 协议说明：MCP 走 JSON-RPC 2.0 over stdio（换行分隔）。这里实现最小可用子集：
 * initialize -> tools/list -> tools/call。之所以手写而不引第三方 SDK，
 * 是为了让依赖面最小、行为可完全掌控（避免上游版本漂移）。
 */

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

/** 暴露给模型的工具白名单（按任务书六项能力裁剪，避免工具过多导致模型选错） */
const EXPOSED_TOOLS = new Set([
  // 终端执行 / 打开软件 / 打开网页 / 项目创建
  "start_process",
  "interact_with_process",
  "read_process_output",
  "list_processes",
  // 文件管理
  "read_file",
  "write_file",
  "list_directory",
  "create_directory",
  "move_file",
  "get_file_info",
  // 代码生成（定向编辑）
  "edit_block",
  // 搜索
  "start_search",
]);

export class McpClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: JsonRpcResponse) => void; timer: NodeJS.Timeout }>();
  private stdoutBuffer = "";
  private tools: McpTool[] = [];
  private initialized = false;
  private serverPkgPath = "";

  isReady(): boolean {
    return this.initialized && this.proc !== null && !this.proc.killed;
  }

  getTools(): McpTool[] {
    return [...this.tools];
  }

  /** 定位内置的 desktop-commander 包入口 */
  private resolveServerEntry(): string | null {
    const fs = require("node:fs") as typeof import("node:fs");
    const candidates: string[] = [];

    // 1) 通过 node 解析（打包后位于 app.asar 内）
    try {
      candidates.push(
        require.resolve("@wonderwhy-er/desktop-commander/dist/index.js", { paths: [process.cwd()] })
      );
    } catch {
      /* 未安装则忽略 */
    }
    try {
      candidates.push(require.resolve("@wonderwhy-er/desktop-commander/dist/index.js", { paths: [__dirname] }));
    } catch {
      /* ignore */
    }

    // 2) 显式路径候选（打包后 asarUnpack 会把 node_modules 解包到 app.asar.unpacked）
    const resRoot = process.resourcesPath || "";
    candidates.push(
      path.join(resRoot, "app.asar.unpacked", "node_modules", "@wonderwhy-er", "desktop-commander", "dist", "index.js"),
      path.join(process.cwd(), "node_modules", "@wonderwhy-er", "desktop-commander", "dist", "index.js")
    );

    for (const raw of candidates) {
      if (!raw) continue;
      // 关键：asar 内的路径无法作为子进程启动，必须指向解包后的真实文件
      const real = raw.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`).replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
      for (const cand of [real, raw]) {
        try {
          if (fs.existsSync(cand)) return cand;
        } catch {
          /* ignore */
        }
      }
    }
    return null;
  }

  async start(): Promise<{ ok: boolean; reason?: string }> {
    const pre = safetyManager.validateMcpPreconditions();
    if (!pre.ok) {
      logger.warn(`[MCP] 未启动：${pre.reason}`);
      this.emit("unavailable", pre.reason);
      return { ok: false, reason: pre.reason };
    }

    const entry = this.resolveServerEntry();
    if (!entry) {
      const reason = "未找到内置的 DesktopCommanderMCP。请在项目根执行依赖安装（npm install）。";
      logger.warn(`[MCP] 未启动：${reason}`);
      this.emit("unavailable", reason);
      return { ok: false, reason };
    }
    this.serverPkgPath = entry;

    try {
      this.proc = spawn(process.execPath, [entry], {
        cwd: path.dirname(entry),
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          // 让子进程知道这是被 Electron 启动（避免误用 electron 的 node）
          ELECTRON_RUN_AS_NODE: "1",
        },
      });
    } catch (e) {
      const reason = `MCP 子进程启动失败：${(e as Error).message}`;
      logger.error(`[MCP] ${reason}`);
      this.emit("unavailable", reason);
      return { ok: false, reason };
    }

    this.proc.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.proc.stderr?.on("data", (chunk: Buffer) => {
      const s = chunk.toString().trim();
      if (s) logger.warn(`[MCP stderr] ${s.slice(0, 400)}`);
    });
    this.proc.on("exit", (code, signal) => {
      logger.warn(`[MCP] 子进程退出 code=${code} signal=${signal}`);
      this.initialized = false;
      this.proc = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ jsonrpc: "2.0", id: -1, error: { code: -32000, message: "MCP 子进程已退出" } });
      }
      this.pending.clear();
      this.emit("exited", { code, signal });
    });
    this.proc.on("error", (err) => {
      logger.error("[MCP] 子进程错误:", err.message);
    });

    // MCP 握手
    try {
      const init = await this.rpc("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "jarvis-desktop-assistant", version: "1.0.0" },
      });
      if (init.error) throw new Error(init.error.message);
      this.notify("notifications/initialized", {});
      this.initialized = true;
      logger.info("[MCP] 初始化完成");
    } catch (e) {
      const reason = `MCP 初始化失败：${(e as Error).message}`;
      logger.error(`[MCP] ${reason}`);
      return { ok: false, reason };
    }

    // 工具发现
    try {
      const list = await this.rpc("tools/list", {});
      const all: McpTool[] = list.result?.tools || [];
      this.tools = all.filter((t) => EXPOSED_TOOLS.has(t.name));
      logger.info(
        `[MCP] 工具发现：共 ${all.length} 个，其中暴露给模型 ${this.tools.length} 个（${this.tools.map((t) => t.name).join(", ")}）`
      );
      this.emit("tools", this.tools);
    } catch (e) {
      logger.error("[MCP] 工具发现失败:", e);
    }

    return { ok: true };
  }

  stop(): void {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* ignore */
      }
      this.proc = null;
    }
    this.initialized = false;
  }

  /* ---------------- JSON-RPC ---------------- */

  private notify(method: string, params: unknown): void {
    if (!this.proc?.stdin?.writable) return;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  private rpc(method: string, params: unknown, timeoutMs = 60_000): Promise<JsonRpcResponse> {
    return new Promise((resolve) => {
      if (!this.proc?.stdin?.writable) {
        resolve({ jsonrpc: "2.0", id: -1, error: { code: -32000, message: "MCP 子进程不可用" } });
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ jsonrpc: "2.0", id, error: { code: -32001, message: `调用 ${method} 超时（${timeoutMs}ms）` } });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString();
    let idx: number;
    while ((idx = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, idx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        // 非 JSON 输出（如启动横幅）忽略
        continue;
      }
      if (typeof msg.id === "number" && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        p.resolve(msg as JsonRpcResponse);
      } else if (msg.method) {
        // 服务端主动通知，记录即可
        logger.info(`[MCP notification] ${msg.method}`);
      }
    }
  }

  /* ---------------- 工具调用（含安全闸门） ---------------- */

  /**
   * 执行一次工具调用。
   * 流程：风险评估 -> 必要时人工确认 -> 调用 -> 审计。
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{ ok: boolean; output: string; rejected?: boolean }> {
    const started = Date.now();

    if (!this.isReady()) {
      return { ok: false, output: "MCP 未就绪，无法执行工具。" };
    }

    // 1. 安全评估
    const risk = safetyManager.needsConfirmation(toolName, args);
    if (risk.need) {
      const req: SecurityConfirmRequest = {
        requestId: `cfm_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`,
        riskLevel: risk.level,
        actionType: toolName === "start_process" ? "terminal_command" : "file_write",
        title: `是否允许执行：${toolName}`,
        target: String(
          (args.command as string) ||
            (args.path as string) ||
            (args.filePath as string) ||
            JSON.stringify(args).slice(0, 200)
        ),
        explanation: `${risk.label}\n\n参数：${JSON.stringify(args, null, 2).slice(0, 800)}`,
      };

      logger.info(`[MCP] 高风险操作需人工确认：${toolName} (${risk.label})`);
      const approved = await safetyManager.requestConfirmation(req);
      if (!approved) {
        safetyManager.auditToolCall(toolName, args, "rejected", Date.now() - started);
        return { ok: false, output: "用户拒绝执行该操作。请勿重试，改为向用户说明原因或提供替代方案。", rejected: true };
      }
    }

    // 2. 执行
    try {
      const res = await this.rpc("tools/call", { name: toolName, arguments: args }, 90_000);
      const dur = Date.now() - started;

      if (res.error) {
        safetyManager.auditToolCall(toolName, args, "error", dur, res.error.message);
        return { ok: false, output: `工具执行出错：${res.error.message}` };
      }

      const content = res.result?.content;
      let text = "";
      if (Array.isArray(content)) {
        text = content
          .map((c: any) => (typeof c?.text === "string" ? c.text : JSON.stringify(c)))
          .join("\n");
      } else if (typeof res.result === "string") {
        text = res.result;
      } else {
        text = JSON.stringify(res.result ?? {});
      }

      const isError = Boolean(res.result?.isError);
      safetyManager.auditToolCall(toolName, args, isError ? "failed" : "success", dur, text);
      return { ok: !isError, output: text || (isError ? "工具返回错误（无详情）" : "执行完成（无输出）") };
    } catch (e) {
      const dur = Date.now() - started;
      safetyManager.auditToolCall(toolName, args, "error", dur, (e as Error).message);
      return { ok: false, output: `工具调用异常：${(e as Error).message}` };
    }
  }

  /**
   * 把 MCP 工具转换为模型可用的 function 定义。
   * StepFun 约束：name ≤64 字符，仅英文数字与 `_` `-`。
   */
  toModelTools(): Array<Record<string, unknown>> {
    return this.tools.map((t) => ({
      type: "function",
      function: {
        name: sanitizeToolName(t.name),
        description: (t.description || `${t.name} 工具`).slice(0, 1024),
        parameters: t.inputSchema || { type: "object", properties: {} },
      },
    }));
  }
}

/** 把工具名规范化到 StepFun 允许的字符集与长度 */
export function sanitizeToolName(name: string): string {
  let n = name.replace(/[^A-Za-z0-9_-]/g, "_");
  if (n.length > 64) n = n.slice(0, 64);
  return n;
}

export const mcpClient = new McpClient();
