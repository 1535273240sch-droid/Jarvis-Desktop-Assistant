import { execFile, spawnSync, ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "./logger";
import { configManager } from "./config";
import { userDataDir } from "./user-path";

/**
 * Windows-MCP 一键安装器（用户点面板按钮触发，不自动下载）。
 *
 * 背景：Windows-MCP 是 Python 生态的外部程序，此前需要用户手动
 *   powershell -c "irm astral.sh/uv/install.ps1 | iex" && uv tool install windows-mcp
 * 步骤多且对国内网络不友好。本模块把整套流程收敛成一个按钮：
 *   1. 已装（PATH 或 uv 默认位置存在 windows-mcp.exe）→ 直接返回；
 *   2. 缺 uv → 下载便携版 uv（GitHub 直连，失败自动切国内镜像）解压到 userData/tools/uv/；
 *   3. uv tool install windows-mcp（托管 Python 走 npmmirror 镜像，PyPI 走默认源，
 *      失败重试清华 TUNA 源）；
 *   4. 定位 windows-mcp.exe 绝对路径并写入 mcpServers（绝对路径，避免 PATH 问题），
 *      立即重连外部 MCP。
 *
 * 注意：这一步只装「桌面控制」能力，不改变任何安全边界——所有工具调用仍走
 * ActionPolicy 闸门与审计。
 */

const UV_VERSION = "0.12.19";
const UV_URLS = [
  `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`,
  `https://gh-proxy.com/https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`,
];
/** uv 托管 Python 下载镜像（python-build-standalone） */
const PY_INSTALL_MIRROR = "https://registry.npmmirror.com/-/binary/python-build-standalone";
/** PyPI 备用源（默认源失败时重试） */
const PYPI_FALLBACK = "https://pypi.tuna.tsinghua.edu.cn/simple";

let inFlight: Promise<{ ok: boolean; exePath?: string; log: string }> | null = null;
/** 安装期间在跑的子进程（uv / powershell）；应用退出时要一并清掉，否则会留成孤儿 */
const activeChildren = new Set<ChildProcess>();

function run(
  exe: string,
  args: string[],
  opts: { timeoutMs?: number; env?: Record<string, string> } = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      exe,
      args,
      {
        timeout: opts.timeoutMs ?? 600_000,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ...(opts.env || {}) },
      },
      (err, stdout, stderr) => {
        // exit code != 0 时 err 是 Error 且带 code
        if (err && typeof (err as any).code !== "number") return reject(err);
        resolve({ code: err ? Number((err as any).code) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
      }
    );
    activeChildren.add(child);
    child.on("close", () => activeChildren.delete(child));
  });
}

/** 在 PATH 或 uv 默认 bin 目录里找 windows-mcp.exe */
async function findInstalledExe(): Promise<string | null> {
  const localBin = path.join(process.env.USERPROFILE || "", ".local", "bin", "windows-mcp.exe");
  if (fs.existsSync(localBin)) return localBin;
  const where = await run("where.exe", ["windows-mcp"], { timeoutMs: 15_000 }).catch(() => null);
  if (where && where.code === 0) {
    const first = where.stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => /windows-mcp(\.exe)?$/i.test(s));
    if (first) return first;
  }
  return null;
}

async function ensureUv(log: (s: string) => void): Promise<string> {
  // 已有系统 uv 直接用
  const where = await run("where.exe", ["uv"], { timeoutMs: 15_000 }).catch(() => null);
  if (where && where.code === 0 && where.stdout.trim()) {
    const sysUv = where.stdout.split(/\r?\n/)[0].trim();
    log(`使用系统已安装的 uv：${sysUv}`);
    return sysUv;
  }
  // 否则下载便携版到 userData/tools/uv/
  const dir = path.join(userDataDir(), "tools");
  const uvExe = path.join(dir, "uv", "uv.exe");
  if (fs.existsSync(uvExe)) {
    log(`使用已下载的便携 uv：${uvExe}`);
    return uvExe;
  }
  fs.mkdirSync(dir, { recursive: true });
  const zipPath = path.join(dir, "uv.zip");
  let lastErr = "";
  for (const url of UV_URLS) {
    try {
      log(`下载 uv（${url.includes("gh-proxy") ? "镜像" : "官方源"}）…`);
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(zipPath, buf);
      log(`uv 下载完成（${Math.round(buf.length / 1024 / 1024)}MB），解压中…`);
      await run("powershell.exe", ["-NoProfile", "-Command",
        `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${path.join(dir, "uv").replace(/'/g, "''")}' -Force`],
        { timeoutMs: 120_000 });
      if (!fs.existsSync(uvExe)) throw new Error("解压后未找到 uv.exe");
      return uvExe;
    } catch (e) {
      lastErr = (e as Error).message;
      log(`下载/解压失败：${lastErr.slice(0, 120)}，尝试下一个源…`);
    }
  }
  throw new Error(`uv 下载失败（已尝试官方源与镜像）：${lastErr}`);
}

async function installWindowsMcpInternal(log: (s: string) => void): Promise<{ ok: boolean; exePath?: string; log: string }> {
  const lines: string[] = [];
  const emit = (s: string) => {
    lines.push(s);
    log(s);
    logger.info(`[WMCP-Installer] ${s}`);
  };

  // 1) 已装？
  const found = await findInstalledExe();
  if (found) {
    emit(`已检测到 windows-mcp：${found}`);
    return { ok: true, exePath: found, log: lines.join("\n") };
  }

  // 2) uv
  emit("未检测到 windows-mcp，开始安装（首次约 2-5 分钟，取决于网络）…");
  const uvExe = await ensureUv(emit);

  // 3) 安装（托管 Python 走镜像；PyPI 失败重试 TUNA）
  const attempts: Array<{ env: Record<string, string>; label: string }> = [
    { env: { UV_PYTHON_INSTALL_MIRROR: PY_INSTALL_MIRROR }, label: "默认 PyPI 源" },
    { env: { UV_PYTHON_INSTALL_MIRROR: PY_INSTALL_MIRROR, UV_DEFAULT_INDEX: PYPI_FALLBACK }, label: "TUNA 备用源" },
  ];
  let lastOut = "";
  for (const a of attempts) {
    emit(`执行 uv tool install windows-mcp（${a.label}）…`);
    const r = await run(uvExe, ["tool", "install", "windows-mcp"], { env: a.env, timeoutMs: 600_000 }).catch((e) => ({ code: -1, stdout: "", stderr: (e as Error).message }));
    lastOut = (r.stdout + "\n" + r.stderr).trim();
    if (r.code === 0) {
      emit("windows-mcp 安装完成");
      lastOut = "";
      break;
    }
    emit(`安装失败（${a.label}）：${lastOut.slice(-200)}`);
  }
  if (lastOut) return { ok: false, log: lines.join("\n") + "\n" + lastOut };

  // 4) 定位 exe 并写入配置
  const exePath = await findInstalledExe();
  if (!exePath) return { ok: false, log: lines.join("\n") + "\n安装完成但未找到 windows-mcp.exe" };
  const cfg = configManager.get();
  const servers = (cfg.mcpServers || []).filter((s) => s.name !== "windows-mcp");
  servers.push({
    name: "windows-mcp",
    command: exePath,
    args: ["serve", "--transport", "stdio", "--exclude-tools", "Screenshot"],
    enabled: true,
  });
  configManager.set({ mcpServers: servers });
  emit(`已写入配置并指向：${exePath}`);
  emit("请在需要时启动语音会话，或点击「刷新状态」查看 19 个工具是否挂载。");
  return { ok: true, exePath, log: lines.join("\n") };
}

export const wmcpInstaller = {
  /** 是否已在配置中启用 windows-mcp */
  isConfigured(): boolean {
    const list = configManager.get().mcpServers || [];
    return list.some((s) => s.name === "windows-mcp" && s.enabled !== false);
  },

  /** 一键安装（并发调用共享同一次执行） */
  install(): Promise<{ ok: boolean; exePath?: string; log: string }> {
    if (inFlight) return inFlight;
    inFlight = installWindowsMcpInternal((s) => {
      // 进度即时广播给面板（避免长时间无反馈）
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { orchestrator } = require("./orchestrator") as typeof import("./orchestrator");
        orchestrator.notifySystem(`🛠 ${s}`);
      } catch {
        /* 面板不可用时忽略 */
      }
    }).finally(() => {
      inFlight = null;
    });
    return inFlight;
  },

  /** 应用退出时中止仍在进行的安装：uv/powershell 是独立进程，不清理会继续在后台下载 */
  cancel(): void {
    for (const child of activeChildren) {
      try {
        if (process.platform === "win32" && child.pid) {
          spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        } else {
          child.kill();
        }
      } catch {
        /* ignore */
      }
    }
    activeChildren.clear();
  },
};
