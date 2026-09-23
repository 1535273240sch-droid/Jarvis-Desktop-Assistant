import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { logger } from "./logger";

/**
 * 应用目录（本机已安装程序发现与可靠启动）。
 *
 * 为什么需要它 —— 实测踩到的真实故障：
 * 用户说「打开浏览器」，模型只能靠猜。它先 `start chrome`（本机没装 Chrome），
 * 再 `start msedge`（msedge.exe **不在 PATH**，也不在 Program Files 标准路径，
 * 更没注册进 App Paths），最后退化成去**单击**桌面上的 Edge 图标 ——
 * 而单击图标不会启动程序，于是「打开浏览器」反复失败。
 *
 * 本模块把「本机到底有什么、怎么启动」变成模型可直接使用的事实：
 *   1. 扫描开始菜单快捷方式、PATH、注册表 StartMenuInternet、常见安装路径；
 *   2. 用中英文别名做模糊匹配（浏览器/浏览器browser/Edge/Chrome…）；
 *   3. 启动时按可靠性排序：真实 exe 全路径 > 快捷方式(Start-Process) > PATH 命令。
 */

export interface InstalledApp {
  /** 稳定标识 */
  id: string;
  /** 展示名（取快捷方式名或 exe 名） */
  name: string;
  /** 可直接启动的路径：exe 全路径或 .lnk 全路径 */
  launchPath: string;
  /** 启动方式 */
  kind: "exe" | "lnk" | "path";
  /** 归一化后的别名，用于模糊匹配 */
  aliases: string[];
}

/** 中文名 -> 常见英文/进程名映射，让「打开浏览器」能命中具体程序 */
const ALIAS_HINTS: Array<{ keys: string[]; targets: string[] }> = [
  { keys: ["浏览器", "网页", "上网", "browser", "web", "internet"], targets: ["浏览器", "edge", "chrome", "firefox", "browser", "iexplore", "fhbrowser"] },
  { keys: ["计算器", "calculator", "calc"], targets: ["calc", "计算器", "calculator"] },
  { keys: ["记事本", "notepad", "文本编辑"], targets: ["notepad", "记事本"] },
  { keys: ["资源管理器", "文件管理器", "我的电脑", "此电脑", "explorer", "file"], targets: ["explorer", "资源管理器", "文件"] },
  { keys: ["终端", "命令行", "cmd", "terminal", "powershell"], targets: ["cmd", "powershell", "terminal", "windows terminal", "wt"] },
  { keys: ["画图", "paint"], targets: ["mspaint", "画图", "paint"] },
  { keys: ["任务管理器", "task manager", "taskmgr"], targets: ["taskmgr", "任务管理器"] },
  { keys: ["微信", "wechat", "weixin"], targets: ["wechat", "微信", "weixin"] },
  { keys: ["qq"], targets: ["qq"] },
  { keys: ["代码", "编辑器", "vscode", "vs code", "code"], targets: ["code", "visual studio code", "vscode"] },
];

function norm(s: string): string {
  return (s || "").toLowerCase().replace(/\s+/g, "").replace(/[（）()【】\[\]·\-_]/g, "");
}

export class AppCatalog {
  private apps: InstalledApp[] = [];
  private scannedAt = 0;
  /** 扫描结果缓存时长：应用安装不频繁，没必要每次问都扫盘 */
  private static readonly CACHE_MS = 5 * 60 * 1000;

  /** 扫描本机可启动程序（带缓存） */
  async scan(force = false): Promise<InstalledApp[]> {
    if (!force && this.apps.length && Date.now() - this.scannedAt < AppCatalog.CACHE_MS) {
      return this.apps;
    }
    const found: InstalledApp[] = [];
    const seen = new Set<string>();

    const add = (name: string, launchPath: string, kind: InstalledApp["kind"]) => {
      const key = norm(launchPath);
      if (!launchPath || seen.has(key)) return;
      // 过滤明显不是应用的项（卸载程序、帮助文档等）
      if (/uninstall|卸载|readme|帮助|help|website|官网/i.test(name)) return;
      seen.add(key);
      const base = path.basename(launchPath).replace(/\.(exe|lnk)$/i, "");
      found.push({
        id: `${kind}:${base}`,
        name: name.replace(/\.lnk$/i, ""),
        launchPath,
        kind,
        aliases: [norm(name), norm(base)],
      });
    };

    // 1) 开始菜单快捷方式：覆盖「装了但不在 PATH」的程序（本机 Edge 就是这种）
    const menuRoots = [
      path.join(process.env.ProgramData || "C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs"),
      path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs"),
    ];
    for (const root of menuRoots) {
      try {
        for (const f of this.walk(root, 3)) {
          if (f.toLowerCase().endsWith(".lnk")) add(path.basename(f, ".lnk"), f, "lnk");
        }
      } catch {
        /* 目录不存在则跳过 */
      }
    }

    // 2) 注册表 StartMenuInternet：系统认定的浏览器（权威，含国产浏览器）
    try {
      const browsers = await this.queryStartMenuInternet();
      for (const b of browsers) add(b.name, b.exe, fs.existsSync(b.exe) ? "exe" : "path");
    } catch {
      /* ignore */
    }

    // 2b) 各用户级安装目录（Edge/Chrome 常装在这里，不在 PATH 也不在 Program Files）
    const localAppData = process.env.LOCALAPPDATA || "";
    for (const [label, rel] of [
      ["Microsoft Edge", path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe")],
      ["Google Chrome", path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe")],
      ["Google Chrome", path.join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe")],
      ["Google Chrome", path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe")],
      ["Microsoft Edge", path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe")],
      ["Firefox", path.join(process.env.ProgramFiles || "C:\\Program Files", "Mozilla Firefox", "firefox.exe")],
    ] as Array<[string, string]>) {
      try {
        if (rel && fs.existsSync(rel)) add(label, rel, "exe");
      } catch {
        /* ignore */
      }
    }

    // 3) 常用系统程序（System32 里一定有，且不需要 PATH）
    const sys32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
    for (const [label, exe] of [
      ["计算器", "calc.exe"],
      ["记事本", "notepad.exe"],
      ["画图", "mspaint.exe"],
      ["任务管理器", "taskmgr.exe"],
      ["命令提示符", "cmd.exe"],
      ["Windows PowerShell", "powershell.exe"],
      ["控制面板", "control.exe"],
      ["远程桌面", "mstsc.exe"],
      ["截图工具", "SnippingTool.exe"],
    ] as Array<[string, string]>) {
      const p = path.join(sys32, exe);
      if (fs.existsSync(p)) add(label, p, "exe");
    }
    const explorerExe = path.join(process.env.SystemRoot || "C:\\Windows", "explorer.exe");
    if (fs.existsSync(explorerExe)) add("资源管理器", explorerExe, "exe");

    // 4) PATH 中的可执行文件（补充便携版程序）
    for (const dir of (process.env.PATH || "").split(path.delimiter)) {
      try {
        if (!dir || !fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir)) {
          if (f.toLowerCase().endsWith(".exe")) add(path.basename(f, ".exe"), path.join(dir, f), "path");
        }
      } catch {
        /* ignore */
      }
    }

    this.apps = found;
    this.scannedAt = Date.now();
    logger.info(`[AppCatalog] 已发现 ${found.length} 个可启动程序`);
    return this.apps;
  }

  private walk(dir: string, depth: number): string[] {
    if (depth < 0) return [];
    const out: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...this.walk(p, depth - 1));
      else out.push(p);
    }
    return out;
  }

  /** 读取系统注册的浏览器列表（含国产浏览器，比 PATH 更权威） */
  private queryStartMenuInternet(): Promise<Array<{ name: string; exe: string }>> {
    const ps = `
$ErrorActionPreference='SilentlyContinue'
$out = @()
foreach ($k in @('HKLM:\\SOFTWARE\\Clients\\StartMenuInternet','HKCU:\\SOFTWARE\\Clients\\StartMenuInternet')) {
  Get-ChildItem $k -ErrorAction SilentlyContinue | ForEach-Object {
    $n = $_.PSChildName
    $cmd = (Get-ItemProperty "$($_.PSPath)\\shell\\open\\command" -ErrorAction SilentlyContinue).'(default)'
    if ($cmd) {
      $exe = $cmd.Trim('"')
      $exe = $exe -replace '^"([^"]+)".*$','$1'
      $out += "$n|$exe"
    }
  }
}
$out | Select-Object -Unique
`;
    return new Promise((resolve) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
         `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${ps}`],
        { timeout: 20000, windowsHide: true, encoding: "utf8" },
        (_err, stdout) => {
          const list = String(stdout || "")
            .split(/\r?\n/)
            .filter(Boolean)
            .map((line) => {
              const i = line.indexOf("|");
              return i > 0 ? { name: line.slice(0, i).trim(), exe: line.slice(i + 1).trim() } : null;
            })
            .filter(Boolean) as Array<{ name: string; exe: string }>;
          resolve(list);
        }
      );
    });
  }

  /**
   * 按用户说法解析目标程序。
   * 例：`浏览器` -> 本机注册的浏览器；`Edge` -> Microsoft Edge；`计算器` -> calc.exe
   * 返回按匹配度排序的候选（可能多个，供上层选择合适的那个）。
   */
  async resolve(query: string): Promise<InstalledApp[]> {
    const apps = await this.scan();
    const q = norm(query);
    if (!q) return [];

    const scores = new Map<InstalledApp, number>();
    const bump = (a: InstalledApp, n: number) => scores.set(a, (scores.get(a) || 0) + n);

    /** 明显是系统内部组件而非用户应用的名称，降权（避免 browser_broker 之类被当成浏览器） */
    const isInternal = (a: InstalledApp) =>
      /broker|export|helper|service|host|runtime|update|crashpad|setup|installer|launcher|daemon/i.test(a.name) ||
      /windows\\(system32|syswow64)\\/i.test(a.launchPath);

    /** 真实浏览器/应用的可执行文件名，命中则显著加分 */
    const REAL_APPS = /\b(msedge|chrome|firefox|iexplore|fhbrowser|calc|notepad|mspaint|explorer|taskmgr|wechat|weixin|qq|code|mstsc|snippingtool)\b/i;

    // 1) 直接命中名称/别名
    for (const a of apps) {
      let s = 0;
      if (a.aliases.some((al) => al === q)) s = 100;
      else if (a.aliases.some((al) => al.length >= 2 && (al.includes(q) || q.includes(al)))) s = 60;
      if (!s) continue;
      if (isInternal(a)) s -= 50;
      if (REAL_APPS.test(path.basename(a.launchPath))) s += 15;
      bump(a, s);
    }

    // 2) 走中文别名映射（「浏览器」这类泛指）
    for (const hint of ALIAS_HINTS) {
      const hit = hint.keys.some((k) => q.includes(norm(k)) || norm(k).includes(q));
      if (!hit) continue;
      for (const a of apps) {
        const base = path.basename(a.launchPath);
        const targetHit = hint.targets.some((t) => {
          const nt = norm(t);
          return a.aliases.some((al) => al.includes(nt)) || norm(base).includes(nt);
        });
        if (!targetHit) continue;
        // 只有别名/文件名里真的出现目标名才给高分，避免目录名误伤
        let s = 40;
        if (REAL_APPS.test(base)) s += 25;
        if (a.kind === "exe") s += 8;
        else if (a.kind === "lnk") s += 4;
        if (isInternal(a)) s -= 45;
        bump(a, s);
      }
    }

    // 3) 用户报的是系统注册浏览器且查询含「浏览器」时，优先真正的 msedge/chrome 可执行文件
    if (/浏览器|browser|上网/.test(q)) {
      for (const a of apps) {
        if (/(msedge|chrome|firefox)\.exe$/i.test(a.launchPath)) bump(a, 20);
      }
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([a]) => a)
      .filter((a) => (scores.get(a) || 0) >= 40);
  }

  /** 供提示词使用的「本机可用程序」摘要（只列常用的，避免提示词过长） */
  async buildPromptSection(limit = 40): Promise<string> {
    const apps = await this.scan();
    const priority = ["浏览器", "edge", "chrome", "firefox", "fhbrowser", "计算器", "calc", "记事本", "notepad",
      "资源管理器", "explorer", "命令提示符", "cmd", "powershell", "微信", "wechat", "qq", "画图", "mspaint"];
    const picked: InstalledApp[] = [];
    for (const p of priority) {
      const hit = apps.find((a) => a.aliases.some((al) => al.includes(norm(p))));
      if (hit && !picked.includes(hit)) picked.push(hit);
      if (picked.length >= limit) break;
    }
    if (!picked.length) return "";
    return (
      "【本机可用程序（由系统实际扫描得出，请优先用 open_app 工具按名称启动）】\n" +
      picked.map((a) => `- ${a.name}`).join("\n")
    );
  }
}

export const appCatalog = new AppCatalog();
