import { desktopCapturer, screen } from "electron";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { logger } from "./logger";
import { configManager } from "./config";
import { safetyManager } from "./safety";
import { isAuthorized, ensureAutoAuthorized } from "./authorization";
import { parseVisionTarget, stripTargetJson, COORDINATE_CONTRACT } from "./vision-target";
import type { VisionResult } from "../common/types";

/**
 * 屏幕视觉通道。
 *
 * 架构要点（本项目最重要的一条约束）：
 * 实时语音 WebSocket 的 modalities 固定为 ["text","audio"]，**推不了图像**。
 * 所以「看屏幕」必须走一条独立的 HTTP 通道：
 *   截图(desktopCapturer) -> 编码 -> HTTP POST 视觉模型 -> 文本 -> 回注实时会话
 *
 * 技术选型说明：截图用 Electron 内置的 desktopCapturer；当前窗口识别与鼠标键盘
 * 通过 PowerShell + Win32 API 实现，**不引入 nut.js/robotjs 这类原生模块**，
 * 从而避免 Electron ABI 重建与打包解包问题。代价是单次调用有约 100–300ms 的
 * PowerShell 启动开销，对「点击一次按钮」这类交互可以接受。
 *
 * T07 关键升级（坐标定位）：
 *  - 活动窗口截图按**窗口物理像素尺寸**请求缩略图，保证图像与屏幕 region 一一对应；
 *  - 视觉模型按约定在回复里附一段坐标 JSON（阶跃官方无 grounding 接口，
 *    这是结构化文本输出约定，见 vision-target.ts）；
 *  - understand() 返回图像空间坐标 + region，由 desktop-control 的
 *    coordinate-mapping 换算成屏幕物理坐标（绝不在此处手算）。
 */

export interface ActiveWindowInfo {
  title: string;
  processName: string;
  bounds: { x: number; y: number; width: number; height: number } | null;
}

export interface CaptureMeta {
  png: Buffer;
  /** 截图对应的屏幕物理区域（虚拟桌面坐标，多显示器左侧为负） */
  region: { x: number; y: number; width: number; height: number };
  /** 截图自身像素尺寸（可能被压缩，未必等于 region） */
  width: number;
  height: number;
  displayId: string;
  /** 非空表示未能按预期截取（例如窗口匹配失败退回整屏），需要告知模型与用户 */
  fallbackReason?: string;
}

function runPowerShell(script: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    // 中文 Windows 上 PowerShell 默认按当前控制台代码页（GBK）输出 stdout，
    // 而 Node 按 UTF-8 解码，中文窗口标题会变成 "?????"。
    // 一旦标题被破坏，「按标题匹配捕获源」就会失配、退回整屏，
    // 表现为「让他看屏幕，他一直在看却不知道看的是什么」。
    // 因此强制 PowerShell 以 UTF-8 输出。
    const wrapped = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ${script}`;
    const args = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      wrapped,
    ];
    execFile(
      "powershell.exe",
      args,
      { timeout: timeoutMs, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`PowerShell 执行失败: ${err.message} ${String(stderr).slice(0, 300)}`));
          return;
        }
        resolve(String(stdout).trim());
      }
    );
  });
}

class VisionManager {
  /* ---------------- 截图 ---------------- */

  /** 抓取屏幕或活动窗口，返回 PNG Buffer（兼容旧调用方） */
  async captureScreen(target: "entire_screen" | "active_window" = "entire_screen"): Promise<Buffer> {
    const meta = await this.captureWithMeta(target);
    return meta.png;
  }

  /**
   * 抓取屏幕或活动窗口，带回坐标换算所需的元数据。
   * 活动窗口按窗口物理尺寸请求原图：thumbnailSize 与窗口尺寸一致时
   * desktopCapturer 不会二次缩放，图像像素与屏幕物理像素一一对应。
   */
  async captureWithMeta(target: "entire_screen" | "active_window" = "entire_screen"): Promise<CaptureMeta> {
    // 全自动模式：首次调用自动落盘授权，不再中断用户操作
    if (!isAuthorized("screen-capture")) {
      ensureAutoAuthorized();
    }

    if (target === "active_window") {
      const win = await this.getActiveWindow();
      if (win?.bounds && win.bounds.width > 0 && win.bounds.height > 0) {
        // 窗口矩形是物理像素（PowerShell 取的是屏幕坐标；Electron 主进程
        // 为 per-monitor DPI aware 时与桌面Capturer 的物理像素一致）
        const w = Math.round(win.bounds.width);
        const h = Math.round(win.bounds.height);
        const sources = await desktopCapturer.getSources({
          types: ["window"],
          thumbnailSize: { width: w, height: h },
        });
        // 标题匹配：先精确、再前缀，最后双向包含（标题可能被截断或带后缀）
        const norm = (s: string) => (s || "").replace(/\s+/g, " ").trim();
        const target0 = norm(win.title);
        let hit = sources.find((s) => norm(s.name) === target0);
        if (!hit && target0.length >= 4) {
          const head = target0.slice(0, 24);
          hit = sources.find((s) => norm(s.name).startsWith(head));
        }
        if (!hit && target0.length >= 4) {
          hit = sources.find((s) => {
            const n = norm(s.name);
            return n.length >= 4 && (n.includes(target0) || target0.includes(n));
          });
        }
        if (hit && !hit.thumbnail.isEmpty()) {
          const size = hit.thumbnail.getSize();
          logger.info(`[Vision] 活动窗口原图 ${size.width}x${size.height}（窗口 ${w}x${h}）`);
          safetyManager.audit("screenshot", { target: "active_window", title: win.title, size });
          return {
            png: hit.thumbnail.toPNG(),
            region: win.bounds,
            width: size.width,
            height: size.height,
            displayId: this.displayOfPoint(win.bounds),
          };
        }
        // 匹配失败时不要静默退回整屏：整屏会让模型看到一堆无关内容，
        // 用户体感就是「一直在看，却不知道在看什么」。改为明确告知。
        logger.warn(
          `[Vision] 未能匹配到窗口捕获源：title="${win.title}"，可用源=${sources.length} 个` +
            `（前几个：${sources.slice(0, 5).map((s) => norm(s.name).slice(0, 20)).join(" / ") || "无"}）`
        );
        safetyManager.audit("screenshot_window_match_failed", {
          title: win.title,
          processName: win.processName,
          sourceCount: sources.length,
        });
        const fallback = await this.captureEntireScreen();
        return { ...fallback, fallbackReason: `未匹配到窗口「${win.title}」，已改为整屏截图` } as CaptureMeta;
      }
    }

    if (target === "active_window") {
      logger.warn("[Vision] 未识别到活动窗口，回退整屏截图");
    }
    return this.captureEntireScreen();
  }

  /** 整屏截图（按主显示器物理像素请求，限制最大边长控制体积） */
  private async captureEntireScreen(): Promise<CaptureMeta> {
    // 整屏：按主显示器物理像素请求
    let thumbSize = { width: 1920, height: 1080 };
    let region = { x: 0, y: 0, width: 1920, height: 1080 };
    let displayId = "0";
    try {
      const display = screen.getPrimaryDisplay();
      const scale = display.scaleFactor || 1;
      thumbSize = {
        width: Math.round(display.size.width * scale),
        height: Math.round(display.size.height * scale),
      };
      region = { x: Math.round(display.bounds.x * scale), y: Math.round(display.bounds.y * scale), ...thumbSize };
      displayId = String(display.id);
      // 限制最大边长，控制图片体积（降低延迟与费用）
      const maxEdge = 1920;
      const ratio = Math.min(1, maxEdge / Math.max(thumbSize.width, thumbSize.height));
      thumbSize = { width: Math.round(thumbSize.width * ratio), height: Math.round(thumbSize.height * ratio) };
    } catch {
      /* 使用默认值 */
    }

    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: thumbSize });
    // 图源必须与 region 对应：此前取 sources[0]，多显示器下可能拿到别的屏，
    // 导致 region 与实际画面不一致、坐标换算整体偏移。
    const wantedPrefix = `screen:${displayId}:`;
    const matching = sources.find((s) => s.id.startsWith(wantedPrefix));
    const scr = matching ?? sources.find((s) => s.id.startsWith(`screen:${displayId}`)) ?? sources[0];
    if (!scr) throw new Error("未获取到屏幕捕获源");
    if (!matching) {
      logger.warn(
        `[Vision] 未找到与主显示器(id=${displayId})对应的捕获源，已退回 ${scr.id}；` +
          `region 与画面可能不一致，坐标换算结果需谨慎使用`
      );
    } else {
      // 命中时用该源的物理尺寸校正 region，保证 图像像素 ↔ 屏幕物理像素 一一对应
      const size = scr.thumbnail.getSize();
      if (size.width > 0 && size.height > 0) {
        const scaleX = region.width / size.width;
        const scaleY = region.height / size.height;
        if (Math.abs(scaleX - scaleY) > 0.02 || scaleX < 1) {
          // 缩略图被压缩：region 不变（它描述的是屏幕区域），仅在日志中留痕
          logger.info(`[Vision] 整屏缩略图 ${size.width}x${size.height}，屏幕区域 ${region.width}x${region.height}（含缩放）`);
        }
      }
    }
    safetyManager.audit("screenshot", { target: "entire_screen", size: thumbSize, sourceId: scr.id });
    return {
      png: scr.thumbnail.toPNG(),
      region,
      width: thumbSize.width,
      height: thumbSize.height,
      displayId,
    };
  }

  /** 窗口中心点落在哪块显示器 */
  private displayOfPoint(bounds: { x: number; y: number; width: number; height: number }): string {
    try {
      const cx = bounds.x + bounds.width / 2;
      const cy = bounds.y + bounds.height / 2;
      const hit = screen.getAllDisplays().find((d) => {
        const s = d.scaleFactor || 1;
        return (
          cx >= d.bounds.x * s &&
          cx <= (d.bounds.x + d.bounds.width) * s &&
          cy >= d.bounds.y * s &&
          cy <= (d.bounds.y + d.bounds.height) * s
        );
      });
      return String(hit?.id ?? screen.getPrimaryDisplay().id);
    } catch {
      return "0";
    }
  }

  /* ---------------- 活动窗口识别 ---------------- */

  async getActiveWindow(): Promise<ActiveWindowInfo | null> {
    const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class W {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder t, int c);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static string Run() {
    IntPtr h = GetForegroundWindow();
    StringBuilder sb = new StringBuilder(512);
    GetWindowTextW(h, sb, sb.Capacity);
    int pid; GetWindowThreadProcessId(h, out pid);
    RECT r; GetWindowRect(h, out r);
    string pname = "";
    try { pname = System.Diagnostics.Process.GetProcessById(pid).ProcessName; } catch {}
    return sb.ToString() + "|" + pname + "|" + r.L + "," + r.T + "," + (r.R-r.L) + "," + (r.B-r.T);
  }
}
"@
[W]::Run()
`;
    try {
      const out = await runPowerShell(ps);
      const [title = "", processName = "", rect = ""] = out.split("|");
      const nums = rect.split(",").map((n) => Number.parseInt(n, 10));
      const bounds =
        nums.length === 4 && nums.every((n) => Number.isFinite(n))
          ? { x: nums[0], y: nums[1], width: nums[2], height: nums[3] }
          : null;
      logger.info(`[Vision] 活动窗口: "${title}" (${processName})`);
      return { title, processName, bounds };
    } catch (e) {
      logger.warn("[Vision] 获取活动窗口失败:", (e as Error).message);
      return null;
    }
  }

  /* ---------------- 视觉理解（独立 HTTP 通道） ------------------ */

  /**
   * 把截图交给视觉模型，得到文本描述与（可选的）目标定位。
   * 模型 ID 与端点均来自配置（可改）。注意：阶跃官方视觉模型**没有**
   * grounding/坐标接口，定位采用结构化文本约定（见 vision-target.ts），
   * 属于模型估算，执行前必须高亮 + 人工确认。
   */
  async understand(prompt: string, imagePng: Buffer, meta?: { width: number; height: number }): Promise<VisionResult> {
    const cfg = configManager.get();
    const effectiveKey = (cfg.visionApiKey && cfg.visionApiKey.trim()) || cfg.apiKey;
    if (!effectiveKey && !cfg.visionBaseUrl.includes("localhost") && !cfg.visionBaseUrl.includes("127.0.0.1")) {
      return { success: false, analysisText: "", errorMessage: "未配置 API Key，无法进行屏幕理解。请在设置中配置 API Key 或自定义视觉 Key。" };
    }

    const dataUrl = `data:image/png;base64,${imagePng.toString("base64")}`;
    const visionPrompt = meta
      ? `${prompt}\n\n【屏幕图像信息】图像尺寸 ${meta.width}x${meta.height} 像素（坐标原点在左上角）。\n${COORDINATE_CONTRACT(meta.width, meta.height)}`
      : prompt;

    const body = {
      model: cfg.visionModel,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: visionPrompt },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      // 关键：step-5-preview 等是**推理型**多模态模型，会先产出大量 reasoning
      // 再产出 content。max_tokens 太小会把预算全烧在思维链上，导致 content 为空串
      // （实测 1024 时返回 200 但正文为空）。这里给足 4096 确保正文能出来。
      max_tokens: 4096,
      stream: false,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (effectiveKey) {
        headers["Authorization"] = `Bearer ${effectiveKey}`;
      }
      const res = await fetch(cfg.visionBaseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await res.text();
      if (!res.ok) {
        const msg = `视觉接口返回 ${res.status}：${text.slice(0, 300)}`;
        logger.error(`[Vision] ${msg}`);
        safetyManager.audit("vision_call", { ok: false, status: res.status });
        return { success: false, analysisText: "", errorMessage: msg };
      }

      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        return { success: false, analysisText: "", errorMessage: "视觉接口返回非 JSON 内容" };
      }

      const choice = parsed?.choices?.[0];
      const rawContent = choice?.message?.content ?? choice?.text ?? "";
      let analysis = typeof rawContent === "string" ? rawContent : JSON.stringify(rawContent ?? "");

      // 兜底：若正文为空（推理模型把 token 全用在思维链上），退而使用 reasoning 字段，
      // 至少让用户/模型拿到有效信息，而不是一片空白。
      if (!analysis.trim()) {
        const reasoning = choice?.message?.reasoning;
        if (typeof reasoning === "string" && reasoning.trim()) {
          logger.warn("[Vision] 正文为空，回退使用 reasoning 字段内容");
          analysis = reasoning;
        } else {
          const finish = choice?.finish_reason ?? "unknown";
          const usage = JSON.stringify(parsed?.usage ?? {});
          const msg = `视觉模型返回了空内容（finish_reason=${finish}, usage=${usage}）。可能是 max_tokens 过小或被内容审核拦截。`;
          logger.error(`[Vision] ${msg}`);
          safetyManager.audit("vision_call", { ok: false, emptyContent: true, finish });
          return { success: false, analysisText: "", errorMessage: msg };
        }
      }

      logger.info(`[Vision] 视觉理解成功，正文 ${analysis.length} 字`);
      safetyManager.audit("vision_call", { ok: true, promptPreview: prompt.slice(0, 120) });
      return {
        success: true,
        analysisText: analysis,
        previewDataUrl: dataUrl.length < 6_000_000 ? dataUrl : undefined,
      };
    } catch (e) {
      const isAbort = (e as Error).name === "AbortError";
      const msg = isAbort
        ? "视觉接口超时（90 秒未返回）。推理型视觉模型响应较慢，可改用更快的模型（如 step-3.7-flash）或减小截图尺寸。"
        : `视觉接口调用异常：${(e as Error).message}`;
      logger.error(`[Vision] ${msg}`);
      safetyManager.audit("vision_call", { ok: false, error: msg });
      return { success: false, analysisText: "", errorMessage: msg };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** 截图 + 理解，一步到位（供工具调用使用），带回定位与 region 元数据 */
  async captureAndUnderstand(
    prompt: string,
    target: "entire_screen" | "active_window" = "active_window"
  ): Promise<VisionResult> {
    let meta: CaptureMeta;
    try {
      meta = await this.captureWithMeta(target);
    } catch (e) {
      return { success: false, analysisText: "", errorMessage: `截图失败：${(e as Error).message}` };
    }

    const r = await this.understand(prompt, meta.png, { width: meta.width, height: meta.height });
    if (r.success) {
      r.region = meta.region;
      r.imageSize = { width: meta.width, height: meta.height };
      // 截图范围与预期不符时，必须把这件事写进返回文本交给模型。
      // 否则模型拿到一张"并非目标窗口"的整屏图，会给出与用户问题无关的描述，
      // 用户体感就是「它一直在看，却不知道在看什么」。
      if (meta.fallbackReason) {
        r.analysisText = `【注意】${meta.fallbackReason}。以下描述基于整屏画面，可能包含与问题无关的窗口，请据此判断。\n\n${r.analysisText}`;
        logger.warn(`[Vision] ${meta.fallbackReason}`);
      }
      // 解析模型给出的定位（图像像素空间）
      const t = parseVisionTarget(r.analysisText, meta.width, meta.height);
      if (t) {
        r.target = t;
        r.analysisText = stripTargetJson(r.analysisText);
      }
      if (!r.previewDataUrl) {
        r.previewDataUrl = `data:image/png;base64,${meta.png.toString("base64")}`;
      }
    }
    return r;
  }

  /** 保存调试截图到磁盘（供排查） */
  async saveDebugShot(png: Buffer, tag: string): Promise<string> {
    const dir = path.join(os.tmpdir(), "jarvis-shots");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${tag}-${Date.now()}.png`);
    fs.writeFileSync(p, png);
    return p;
  }
}

export const visionManager = new VisionManager();
