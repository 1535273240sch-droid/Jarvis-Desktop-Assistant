import { execFile } from "node:child_process";
import { logger } from "./logger";
import { appCatalog } from "./app-catalog";
import { externalMcp } from "./mcp-external";
import { desktopController } from "./desktop-control";
import { safetyManager } from "./safety";
import { isStopped } from "./emergency-stop";
import type { AppProfile } from "../common/types";

/**
 * 桌面驱动（项目书 P1 desktop-driver）：
 * 把「窗口绑定 → 观察（UIA/截图）→ 动作 → 动作后验证」固化成可复用原语。
 *
 * 观察优先走 Windows-MCP 的 UIA 快照（文本省 token、定位准）；
 * Windows-MCP 未安装或快照失败时回退内置截图 + 视觉描述；
 * 动作优先走 Windows-MCP（Click/Type/Shortcut），回退内置 desktopController
 * （带授权检查、预览高亮与确认）。
 *
 * 硬约束（A3）：动作前必须核对目标窗口仍然有效；禁止跨窗口复用旧坐标。
 */

export interface WindowInfo {
  title: string;
  processName: string;
  hwnd: number;
}

export class DesktopDriver {
  /* ---------------- PowerShell 基础 ---------------- */

  ps(script: string, timeoutMs = 20_000): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
         `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ${script}`],
        { timeout: timeoutMs, windowsHide: true, encoding: "utf8" },
        (err, stdout, stderr) => {
          if (err) reject(new Error(`${String(err.message).slice(0, 200)} ${String(stderr).slice(0, 200)}`));
          else resolve(String(stdout || "").trim());
        }
      );
    });
  }

  /** 枚举有标题的顶层窗口 */
  async listWindows(): Promise<WindowInfo[]> {
    const out = await this.ps(
      `Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { "{0}|{1}|{2}" -f $_.Id, $_.ProcessName, ($_.MainWindowTitle -replace '\\|','/') }`,
      15_000
    ).catch(() => "");
    const wins: WindowInfo[] = [];
    for (const line of out.split("\n")) {
      const parts = line.trim().split("|");
      if (parts.length >= 3 && parts[0]) {
        wins.push({ hwnd: Number(parts[0]), processName: parts[1].toLowerCase(), title: parts.slice(2).join("|") });
      }
    }
    return wins;
  }

  /** 前台窗口（审计与焦点核对用） */
  async foregroundWindow(): Promise<WindowInfo | null> {
    const out = await this.ps(
      `Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FG {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
}
"@
$h=[FG]::GetForegroundWindow(); $pid2=0; [FG]::GetWindowThreadProcessId($h,[ref]$pid2)|Out-Null
$sb=New-Object System.Text.StringBuilder 512; [FG]::GetWindowText($h,$sb,512)|Out-Null
$p=Get-Process -Id $pid2 -ErrorAction SilentlyContinue
"{0}|{1}|{2}" -f $pid2, ($(if($p){$p.ProcessName}else{'unknown'})), $sb.ToString()`,
      15_000
    ).catch(() => "");
    const parts = out.split("|");
    if (parts.length >= 3 && parts[0]) {
      return { hwnd: Number(parts[0]), processName: parts[1].toLowerCase(), title: parts.slice(2).join("|") };
    }
    return null;
  }

  /** 按档案匹配目标窗口 */
  async findWindow(profile: AppProfile): Promise<WindowInfo | null> {
    const wins = await this.listWindows();
    const procs = (profile.processNames || []).map((p) => p.toLowerCase());
    const titles = profile.titleIncludes || [];
    for (const w of wins) {
      if (procs.includes(w.processName)) return w;
      if (titles.some((t) => t && w.title.toLowerCase().includes(t.toLowerCase()))) return w;
    }
    return null;
  }

  /** 把窗口带到前台 */
  async focusWindow(win: WindowInfo): Promise<boolean> {
    const ok = await this.ps(
      `Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FW {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
"@
$p = Get-Process -Id ${win.hwnd} -ErrorAction SilentlyContinue
if ($p -and $p.MainWindowHandle -ne 0) { [FW]::ShowWindow($p.MainWindowHandle, 9) | Out-Null; [FW]::SetForegroundWindow($p.MainWindowHandle) | Out-Null; 'focused' } else { 'gone' }`,
      15_000
    ).then((r) => /focused/.test(r)).catch(() => false);
    if (ok) safetyManager.audit("window_focus", { hwnd: win.hwnd, processName: win.processName, title: win.title.slice(0, 80) });
    return ok;
  }

  /**
   * 启动应用（复用应用目录解析）。返回启动的展示名；失败返回 null。
   */
  async launchByName(name: string, args = ""): Promise<string | null> {
    const candidates = await appCatalog.resolve(name);
    for (const app of candidates.slice(0, 3)) {
      const esc = (s: string) => String(s).replace(/'/g, "''");
      const script =
        app.kind === "path"
          ? `Start-Process -FilePath '${esc(app.launchPath)}'${args ? ` -ArgumentList '${esc(args)}'` : ""} -ErrorAction Stop; 'ok'`
          : `$p = Start-Process -FilePath '${esc(app.launchPath)}'${args ? ` -ArgumentList '${esc(args)}'` : ""} -PassThru -ErrorAction Stop; if ($p) { 'ok' } else { 'gone' }`;
      const ok = await this.ps(script, 20_000).then((r) => /ok/.test(r)).catch(() => false);
      if (ok) {
        safetyManager.audit("task_launch_app", { name, resolved: app.name });
        await new Promise((r) => setTimeout(r, 1500));
        return app.name;
      }
    }
    return null;
  }

  /* ---------------- Windows-MCP 通道 ---------------- */

  private isWindowsMcpReady(): boolean {
    return externalMcp.hasTool("windows-mcp", "Snapshot");
  }

  /** UIA 快照文本（不可用时返回 null，由调用方回退截图） */
  async snapshotText(timeoutMs = 30_000): Promise<string | null> {
    if (!this.isWindowsMcpReady()) return null;
    const full = externalMcp.fullToolName("windows-mcp", "Snapshot");
    if (!full) return null;
    const r = await externalMcp.callTool(full, {}, { timeoutMs });
    if (!r.ok) {
      logger.warn(`[DesktopDriver] UIA 快照失败：${r.output.slice(0, 160)}`);
      return null;
    }
    return r.output;
  }

  /** 通过 Windows-MCP 执行一个桌面动作；未接入时返回 null（调用方回退内置实现） */
  async mcpAction(tool: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<{ ok: boolean; output: string } | null> {
    if (!this.isWindowsMcpReady()) return null;
    const full = externalMcp.fullToolName("windows-mcp", tool);
    if (!full) return null;
    return externalMcp.callTool(full, args, { timeoutMs });
  }

  /* ---------------- 动作原语（带核对与回退） ---------------- */

  /** 检查目标窗口是否仍有效且（可选）处于前台。变化返回 false（调用方必须停下重新定位） */
  async verifyWindow(win: WindowInfo, requireForeground: boolean): Promise<boolean> {
    if (isStopped()) return false;
    const wins = await this.listWindows();
    const still = wins.some((w) => w.hwnd === win.hwnd && w.processName === win.processName);
    if (!still) return false;
    if (requireForeground) {
      const fg = await this.foregroundWindow();
      return Boolean(fg && fg.hwnd === win.hwnd);
    }
    return true;
  }

  /** 向已聚焦的目标窗口输入文本（先核对焦点，A3） */
  async typeIntoWindow(win: WindowInfo, text: string): Promise<{ ok: boolean; output: string }> {
    if (!(await this.verifyWindow(win, true))) {
      return { ok: false, output: `目标窗口「${win.title.slice(0, 60)}」已不在前台，动作已中止（需重新定位）。` };
    }
    const viaMcp = await this.mcpAction("Type", { text });
    if (viaMcp) return viaMcp;
    const msg = await desktopController.typeText(text);
    return { ok: !msg.includes("拒绝"), output: msg };
  }

  /** 向已聚焦的目标窗口发送按键 */
  async pressKeysForWindow(win: WindowInfo, combo: string): Promise<{ ok: boolean; output: string }> {
    if (!(await this.verifyWindow(win, true))) {
      return { ok: false, output: `目标窗口「${win.title.slice(0, 60)}」已不在前台，动作已中止（需重新定位）。` };
    }
    const viaMcp = await this.mcpAction("Shortcut", { combo });
    if (viaMcp) return viaMcp;
    const msg = await desktopController.pressKeys(combo);
    return { ok: !msg.includes("拒绝"), output: msg };
  }

  /** 剪贴板读取（结果提取用，经 Windows-MCP；不可用时返回 null） */
  async readClipboard(): Promise<string | null> {
    const viaMcp = await this.mcpAction("Clipboard", { action: "get" }, 15_000);
    return viaMcp && viaMcp.ok ? viaMcp.output : null;
  }
}

export const desktopDriver = new DesktopDriver();
