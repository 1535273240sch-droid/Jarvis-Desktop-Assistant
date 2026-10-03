import { net } from "electron";
import { configManager } from "./config";
import { BriefingService } from "./briefing";
import type { BriefDeps, FetchFn, LlmConfig } from "./briefing";

/** 走 Chromium 网络栈（net.fetch）：会遵循系统代理，比 Node 自带 fetch 更适合桌面用户环境 */
export const briefFetch: FetchFn = (url, init) => net.fetch(url, init);

/**
 * 整理模型配置。
 * - 没填 briefBaseUrl：复用视觉模型的端点/模型/Key（零配置可用，视觉模型本身是支持文本的对话模型）。
 * - 填了 briefBaseUrl：视为第三方端点，只用 briefApiKey，绝不把主 Key 发给第三方；缺 briefModel 则不启用 LLM。
 * 返回 null = 使用规则口播稿（仍可用，只是没有「整理」）。
 */
export function getBriefLlm(): LlmConfig | null {
  const c = configManager.get();
  const custom = Boolean((c.briefBaseUrl || "").trim());
  const baseUrl = custom ? (c.briefBaseUrl || "").trim() : c.visionBaseUrl;
  const modelOverride = (c.briefModel || "").trim();
  const model = custom ? modelOverride : modelOverride || c.visionModel;
  const apiKey = custom ? (c.briefApiKey || "").trim() : (c.visionApiKey || "").trim() || c.apiKey;
  if (!baseUrl || !model) return null;
  return { baseUrl, model, apiKey };
}

export const briefing = new BriefingService(
  (): BriefDeps => {
    const c = configManager.get();
    return { fetch: briefFetch, feeds: c.briefNewsFeeds ?? [], githubToken: c.githubToken || undefined };
  },
  getBriefLlm
);
