import * as fs from "node:fs";
import * as path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { logger } from "./logger";
import { configManager } from "./config";
import { IPC } from "../common/types";
import type { SecurityConfirmRequest, SecurityConfirmResponse } from "../common/types";

/**
 * 安全与审计。
 *
 * 重要事实（已核实并写入架构文档）：
 * DesktopCommanderMCP 的 allowedDirectories **只约束文件操作，不约束终端命令**，
 * 且可被软链接、命令替换、绝对路径、代码执行绕过。因此它只能当「减少误操作」，
 * 不是沙箱。本模块在其之上再加一层应用级拦截：
 *   1. 危险命令正则识别 -> 强制人工确认
 *   2. 白名单为空时拒绝启动 MCP
 *   3. 全量审计日志（JSONL，只追加）
 */

/** 高危命令特征（命中即需人工确认） */
const DANGEROUS_PATTERNS: Array<{ re: RegExp; label: string; level: "high" | "critical" }> = [
  { re: /\b(rm|rmdir|del|erase)\b\s+.*(\/s|\/q|-rf|-r\b|--recursive|\*)/i, label: "递归删除文件", level: "critical" },
  { re: /\bformat\b/i, label: "格式化磁盘", level: "critical" },
  { re: /\bdiskpart\b/i, label: "磁盘分区操作", level: "critical" },
  { re: /\b(mkfs|fdisk)\b/i, label: "文件系统操作", level: "critical" },
  { re: /\bshutdown\b|\breboot\b/i, label: "关机/重启", level: "critical" },
  { re: /Remove-Item\s+.*-Recurse/i, label: "PowerShell 递归删除", level: "critical" },
  { re: /-EncodedCommand\b/i, label: "PowerShell 编码命令（常用于混淆）", level: "high" },
  { re: /\b(taskkill|Stop-Process)\b/i, label: "结束进程", level: "high" },
  { re: /\b(reg\s+delete|Remove-ItemProperty)\b/i, label: "删除注册表项", level: "high" },
  { re: /\b(curl|wget|Invoke-WebRequest|iwr)\b.*\|\s*(bash|sh|powershell|iex)/i, label: "管道下载执行（远程代码执行）", level: "critical" },
  { re: /\b(net\s+user|net\s+localgroup)\b/i, label: "账户/权限变更", level: "high" },
  { re: /\bcipher\s+\/w\b/i, label: "擦除磁盘空闲空间", level: "critical" },
];

/** 需要人工确认的 MCP 工具（写/删除/进程类） */
const SENSITIVE_TOOLS = new Set([
  "write_file",
  "write_pdf",
  "move_file",
  "edit_block",
  "create_directory",
  "force_terminate",
  "kill_process",
  "set_config_value",
  "start_process",
  "interact_with_process",
]);

interface PendingConfirm {
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
}

class SafetyManager {
  private auditPath: string;
  private pending = new Map<string, PendingConfirm>();
  private panelWindow: (() => BrowserWindow | null) | null = null;

  constructor() {
    let dir: string;
    try {
      dir = path.join(app?.getPath("userData") || process.cwd(), "logs");
    } catch {
      dir = path.join(process.cwd(), "logs");
    }
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.auditPath = path.join(dir, "audit.jsonl");

    ipcMain.on(IPC.TOOL_CONFIRM_RESPONSE, (_e, res: SecurityConfirmResponse) => {
      const p = this.pending.get(res.requestId);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(res.requestId);
        p.resolve(Boolean(res.approved));
      }
    });
  }

  /** 注册「把确认请求送到哪个窗口」的取值函数（聊天面板） */
  setPanelResolver(fn: () => BrowserWindow | null): void {
    this.panelWindow = fn;
  }

  getAuditPath(): string {
    return this.auditPath;
  }

  /** 白名单校验：MCP 目录白名单为空则不允许启动（空数组 = 放开整个文件系统） */
  validateMcpPreconditions(): { ok: boolean; reason?: string } {
    const cfg = configManager.get();
    if (!cfg.mcpEnabled) return { ok: false, reason: "MCP 已在配置中关闭" };
    if (!cfg.allowedDirectories.length) {
      return {
        ok: false,
        reason:
          "未配置任何允许访问的目录（allowedDirectories 为空）。为避免放开整个文件系统，已拒绝启动 MCP。请在设置中配置白名单目录。",
      };
    }
    return { ok: true };
  }

  /** 文本类工具调用（终端命令）的风险评估 */
  assessCommand(command: string): { level: "low" | "high" | "critical"; label?: string } {
    for (const p of DANGEROUS_PATTERNS) {
      if (p.re.test(command)) return { level: p.level, label: p.label };
    }
    return { level: "low" };
  }

  /** 该工具调用是否需要人工确认 */
  needsConfirmation(toolName: string, args: Record<string, unknown>): { need: boolean; level: "medium" | "high" | "critical"; label: string } {
    const cfg = configManager.get();
    if (!cfg.confirmHighRisk) return { need: false, level: "medium", label: "（用户已关闭高风险确认）" };

    // 1. 终端命令：扫描命令文本
    const cmdLike =
      (args.command as string) ||
      (args.cmd as string) ||
      (Array.isArray(args.args) ? (args.args as unknown[]).join(" ") : "") ||
      "";
    if (cmdLike && typeof cmdLike === "string") {
      const r = this.assessCommand(cmdLike);
      if (r.level !== "low") return { need: true, level: r.level, label: r.label || "高风险命令" };
    }

    // 2. 敏感工具一律确认
    if (SENSITIVE_TOOLS.has(toolName)) {
      const label =
        toolName === "set_config_value"
          ? "修改 DesktopCommander 配置（可能被用来放宽限制）"
          : `执行敏感工具 ${toolName}`;
      return { need: true, level: "high", label };
    }

    return { need: false, level: "medium", label: "" };
  }

  /** 请求人工确认：阻塞等待用户点击，超时视为拒绝 */
  async requestConfirmation(req: SecurityConfirmRequest, timeoutMs = 60_000): Promise<boolean> {
    const win = this.panelWindow?.();
    if (!win || win.isDestroyed()) {
      logger.warn("[Safety] 聊天面板不可用，高风险操作按「拒绝」处理:", req.title);
      this.audit("confirm_unavailable", { req, approved: false });
      return false;
    }

    // 确保面板可见，否则用户看不到确认框
    try {
      if (!win.isVisible()) win.show();
      win.focus();
    } catch {
      /* ignore */
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.requestId);
        logger.warn("[Safety] 确认请求超时，按「拒绝」处理:", req.title);
        this.audit("confirm_timeout", { req, approved: false });
        resolve(false);
      }, timeoutMs);

      this.pending.set(req.requestId, { resolve, timer });
      win.webContents.send(IPC.TOOL_CONFIRM_REQUEST, req);
      this.audit("confirm_requested", { req });
    });
  }

  /** 写审计日志（JSONL，只追加） */
  audit(event: string, payload: Record<string, unknown>): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...payload,
    });
    try {
      fs.appendFileSync(this.auditPath, line + "\n", "utf-8");
    } catch (e) {
      logger.error("[Safety] 审计日志写入失败:", e);
    }
  }

  /** 记录一次工具执行（成功/失败/被拒都要留痕） */
  auditToolCall(
    toolName: string,
    args: Record<string, unknown>,
    outcome: "success" | "failed" | "rejected" | "timeout" | "error",
    durationMs: number,
    resultPreview?: string
  ): void {
    this.audit("tool_call", {
      toolName,
      args,
      outcome,
      durationMs,
      resultPreview: resultPreview ? resultPreview.slice(0, 500) : undefined,
    });
  }
}

export const safetyManager = new SafetyManager();
