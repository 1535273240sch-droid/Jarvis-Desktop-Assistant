import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "./logger";
import { configManager } from "./config";
import { userDataDir } from "./user-path";

/**
 * AI 唱歌：调用阶跃星辰 StepFun 音乐生成接口，把用户的一句描述
 * 变成一首完整歌曲，落盘到 userData/music/ 并回传音频数据供渲染层播放。
 *
 * 为什么放在主进程：
 *   - API Key 只允许留在主进程（渲染进程永不接触）；
 *   - 生成是 1~3 分钟的长任务，需要轮询与超时控制，主进程更稳。
 *
 * 接口约定（StepFun 音乐生成）：
 *   提交 POST {base}/v1/audio/music/submit  -> { task_id }
 *   查询 POST {base}/v1/audio/music/query   -> { status, audio, rewritten_lyrics, rewritten_caption, error }
 *   status: PENDING / RUNNING / SUCCESS / FAILED
 *   约束：instrumental=true 时禁止传 lyrics，否则服务端报错。
 */

const DEFAULT_BASE_URL = "https://api.stepfun.com";
const DEFAULT_MODEL = "stepaudio-3-music-preview";
/** 建议每 5 秒轮询一次 */
const POLL_INTERVAL_MS = 5_000;
/** 轮询总上限：生成一首完整歌曲通常 1~3 分钟，留足余量到 6 分钟 */
const POLL_TIMEOUT_MS = 6 * 60 * 1000;
/** 单次 HTTP 请求超时 */
const REQUEST_TIMEOUT_MS = 30_000;
/** 无状态变化时，最多每隔这么久播报一次「仍在创作」，避免刷屏 */
const PROGRESS_IDLE_MS = 30_000;

export interface CreateSongOptions {
  /** 曲风 + 人声 + 情绪 + 节奏的描述（中英文均可） */
  caption: string;
  /** 可选歌词，可带 [Verse 1]/[Chorus 1] 结构标签 */
  lyrics?: string;
  /** 是否只要纯音乐（true 时忽略 lyrics） */
  instrumental?: boolean;
  /** 进度回调，用于向用户播报（如「正在谱曲演唱…」） */
  onProgress?: (msg: string) => void;
}

export interface CreateSongResult {
  ok: boolean;
  /** 生成成功时音频的绝对路径（userData/music/*.mp3） */
  filePath?: string;
  /** 生成成功时的 mp3 base64（无 data URL 前缀），供渲染层直接播放，省一次读盘 */
  audioBase64?: string;
  /** 服务端改写后的最终风格描述 */
  caption?: string;
  /** 服务端改写后的最终歌词 */
  lyrics?: string;
  /** 失败原因（中文，可直接告知用户） */
  reason?: string;
}

/** 带 HTTP 状态与业务错误码的异常，便于把错误码翻译成中文提示 */
class MusicApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "MusicApiError";
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class MusicStudio {
  /** 单飞：同一时刻只允许一个生成任务，避免重复扣费与资源争抢 */
  private running = false;

  isRunning(): boolean {
    return this.running;
  }

  async createSong(opts: CreateSongOptions): Promise<CreateSongResult> {
    if (this.running) {
      return { ok: false, reason: "已有一首歌正在生成中，请等这首完成后再试。" };
    }

    const caption = String(opts.caption || "").trim();
    if (!caption) {
      return { ok: false, reason: "缺少歌曲风格描述（caption），无法生成。" };
    }

    const cfg = configManager.get();
    // 音乐可单独配 Key；未单独配置时沿用主 Key
    const apiKey = String(cfg.musicApiKey || cfg.apiKey || "").trim();
    if (!apiKey) {
      return {
        ok: false,
        reason:
          "尚未配置音乐生成所需的 API Key。请在「设置」中填写 StepFun API Key（或单独的音乐 API Key）后重试。",
      };
    }
    const baseUrl = String(cfg.musicBaseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
    const model = String(cfg.musicModel || DEFAULT_MODEL).trim();

    const instrumental = opts.instrumental === true;
    const lyrics = typeof opts.lyrics === "string" ? opts.lyrics.trim() : "";

    const progress = (msg: string): void => {
      try {
        opts.onProgress?.(msg);
      } catch {
        /* 进度回调异常不应影响生成 */
      }
    };

    this.running = true;
    const startedAt = Date.now();
    try {
      progress("正在提交音乐生成任务…");

      const submitBody: Record<string, unknown> = {
        task: "text_to_music",
        model_id: model,
        caption,
        instrumental,
        response_format: "mp3",
      };
      // 纯音乐模式服务端禁止携带 lyrics，这里严格遵循
      if (!instrumental && lyrics) submitBody.lyrics = lyrics;

      const submitted = await this.postJson(`${baseUrl}/v1/audio/music/submit`, submitBody, apiKey);
      const taskId = submitted?.task_id ? String(submitted.task_id) : "";
      if (!taskId) {
        logger.errorCategorized("network", "Music", "提交音乐任务未返回 task_id", {
          handled: true,
          context: { baseUrl, model },
        });
        return { ok: false, reason: "提交音乐任务失败：服务端未返回任务 ID。" };
      }
      progress("任务已提交，模型正在谱曲演唱（通常需要 1~3 分钟）…");

      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let lastStatus = "";
      let lastProgressAt = Date.now();

      while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        const q = await this.postJson(`${baseUrl}/v1/audio/music/query`, { task_id: taskId }, apiKey);
        const status = String(q?.status || "").toUpperCase();

        if (status === "SUCCESS") {
          const audioB64 = typeof q?.audio === "string" ? q.audio : "";
          if (!audioB64) {
            logger.errorCategorized("network", "Music", "音乐生成成功但未返回音频数据", {
              handled: true,
              context: { taskId },
            });
            return { ok: false, reason: "音乐生成完成，但服务端没有返回音频数据，请稍后重试。" };
          }
          let filePath: string;
          try {
            filePath = this.saveAudio(audioB64);
          } catch (e) {
            logger.errorCategorized("network", "Music", `音乐落盘失败：${(e as Error).message}`, {
              handled: true,
              context: { taskId },
            });
            // 落盘失败但音频已在内存里，仍可播放；只是不返回 filePath
            logger.info(`[Music] 音频落盘失败，仍回传内存中的音频（任务 ${taskId}）`);
            return {
              ok: true,
              audioBase64: audioB64,
              caption: String(q?.rewritten_caption || caption),
              lyrics: String(q?.rewritten_lyrics || lyrics || ""),
            };
          }
          const finalCaption = String(q?.rewritten_caption || caption);
          const finalLyrics = String(q?.rewritten_lyrics || lyrics || "");
          logger.info(`[Music] 歌曲生成完成：${filePath}（耗时 ${Math.round((Date.now() - startedAt) / 1000)} 秒）`);
          return { ok: true, filePath, audioBase64: audioB64, caption: finalCaption, lyrics: finalLyrics };
        }

        if (status === "FAILED") {
          const stage = String(q?.error?.stage || "");
          const message = String(q?.error?.message || "服务端未给出原因");
          const reason =
            stage === "censor"
              ? "歌曲内容未通过审核（可能包含敏感词），请修改歌词或风格描述后重试。"
              : `音乐生成失败（${stage || "未知阶段"}）：${message}`;
          logger.errorCategorized("network", "Music", `音乐生成失败：${reason}`, {
            handled: true,
            context: { taskId, stage },
          });
          return { ok: false, reason };
        }

        // PENDING / RUNNING：状态变化时播报一次；长时间无变化则每 30 秒提示仍在进行
        if (status && status !== lastStatus) {
          lastStatus = status;
          progress(status === "RUNNING" ? "模型正在谱曲演唱…" : "任务排队中，请稍候…");
          lastProgressAt = Date.now();
        } else if (Date.now() - lastProgressAt >= PROGRESS_IDLE_MS) {
          progress(`仍在创作中…（已等待约 ${Math.round((Date.now() - startedAt) / 1000)} 秒）`);
          lastProgressAt = Date.now();
        }
      }

      logger.errorCategorized("network", "Music", "音乐生成轮询超时（约 6 分钟）", {
        handled: true,
        context: { taskId },
      });
      return { ok: false, reason: "生成音乐超时（超过约 6 分钟仍未完成），请稍后重试。" };
    } catch (e) {
      const reason = this.describeError(e);
      logger.errorCategorized("network", "Music", `音乐生成异常：${reason}`, {
        handled: true,
        context: { baseUrl, model },
      });
      return { ok: false, reason };
    } finally {
      this.running = false;
    }
  }

  /** 把 base64 mp3 写入 userData/music/，返回绝对路径（目录不存在则创建） */
  private saveAudio(base64: string): string {
    const dir = path.join(userDataDir(), "music");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(dir, `jarvis-song-${stamp}.mp3`);
    fs.writeFileSync(filePath, Buffer.from(base64, "base64"));
    return filePath;
  }

  /** 带超时的 JSON POST；HTTP 非 2xx 抛 MusicApiError 以便按错误码给出中文提示 */
  private async postJson(url: string, body: Record<string, unknown>, apiKey: string): Promise<any> {
    const f = (globalThis as unknown as { fetch?: (u: string, i?: unknown) => Promise<any> }).fetch;
    if (typeof f !== "function") throw new Error("当前运行环境不支持 fetch");

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await f(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let data: any = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (!res.ok) {
        const code = String(data?.error?.code || data?.code || data?.error || "");
        const message = String(data?.error?.message || data?.message || text || `HTTP ${res.status}`);
        throw new MusicApiError(Number(res.status) || 0, code, message);
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 把底层异常翻译成可直接告知用户的中文原因 */
  private describeError(e: unknown): string {
    if (e instanceof MusicApiError) {
      const code = e.code.toLowerCase();
      if (e.httpStatus === 401 || code.includes("not_allowed")) {
        return "API Key 无效或未授权（401）。请在「设置」中检查 StepFun API Key。";
      }
      if (e.httpStatus === 402 || code.includes("insufficient_credit")) {
        return "账户余额不足（402），无法生成音乐。请先在 StepFun 账户充值后重试。";
      }
      if (e.httpStatus === 404 || code.includes("model_invalid")) {
        return "音乐模型不可用（404）：模型 ID 错误或账号无权限。请在设置中检查音乐模型 ID。";
      }
      if (e.httpStatus === 429 || code.includes("rate_limited")) {
        return "请求过于频繁（429），请稍等片刻再试。";
      }
      if (e.httpStatus === 503 || code.includes("service_unavailable")) {
        return "音乐服务暂时不可用（503），请稍后再试。";
      }
      return `音乐服务返回错误（HTTP ${e.httpStatus}）：${e.message}`;
    }
    if (e instanceof Error) {
      if (e.name === "AbortError") return "请求音乐服务超时，请检查网络后重试。";
      return `生成音乐失败：${e.message}`;
    }
    return `生成音乐失败：${String(e)}`;
  }
}

export const musicStudio = new MusicStudio();
