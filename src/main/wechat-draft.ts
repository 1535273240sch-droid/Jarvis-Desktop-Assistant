import * as fs from "node:fs";
import { createHash } from "node:crypto";
import type { WechatDraftPayload } from "../common/types";

/**
 * 微信草稿构建（项目书 §2.2 流程三 / P3 阻塞期）。
 *
 * 硬边界：
 * - 首阶段交付终点是「Jarvis 面板的草稿与待确认界面」；
 * - **绝不**在微信中执行可能立即发送图片/消息的选择、粘贴、回车动作；
 * - 自动回复/自动发送需要平台接入核查（个人微信 vs 企业微信、接口权限），
 *   未核查前不实现 —— 见 docs/wechat-auto-reply-blocked.md；
 * - 本模块是纯逻辑（fs 除外），可在 CI 直接单测。
 */

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

export interface DraftInput {
  contact: string;
  text: string;
  images: string[];
}

export interface DraftBuildResult {
  ok: boolean;
  /** true=可进入草稿确认界面；false=输入本身不成立（缺联系人且缺正文） */
  payload: WechatDraftPayload;
  errors: string[];
}

export function buildDraft(input: DraftInput): DraftBuildResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const contact = String(input.contact || "").trim();
  const text = String(input.text || "");
  const images: string[] = [];
  const listed: string[] = Array.isArray(input.images) ? input.images.map((p) => String(p).trim()).filter(Boolean) : [];

  if (!contact) errors.push("未指定联系人。请说明要发送给的联系人/群名称。");
  if (!text.trim() && !listed.length) errors.push("正文与图片均为空，没有可草拟的内容。");

  for (const p of listed) {
    try {
      const st = fs.existsSync(p) && fs.statSync(p);
      if (!st) {
        warnings.push(`图片不存在：${p}`);
        continue;
      }
      if (!st.isFile()) {
        warnings.push(`不是文件：${p}`);
        continue;
      }
      if (!IMAGE_EXT_RE.test(p)) {
        warnings.push(`不是常见图片格式（png/jpg/gif/webp/bmp）：${p}`);
        continue;
      }
      images.push(p);
    } catch {
      warnings.push(`无法访问：${p}`);
    }
  }

  if (listed.length && !images.length) warnings.push("所有图片均不可用，草稿将只包含文字。");
  if (text.includes("验证码") || text.toLowerCase().includes("password")) {
    warnings.push("正文包含疑似敏感信息（验证码/密码），请确认后再发送。");
  }

  return {
    ok: errors.length === 0,
    errors,
    payload: {
      contact,
      text,
      images,
      warnings,
      createdAt: Date.now(),
    },
  };
}

/**
 * 幂等键（A7：同一条草稿请求只处理一次）。
 * 相同联系人+正文+图片集合 → 同一 key；调用方用 Set 去重。
 */
export function draftDedupeKey(payload: WechatDraftPayload): string {
  const h = createHash("sha256");
  h.update(payload.contact.trim());
  h.update("\u0000");
  h.update(payload.text.trim());
  h.update("\u0000");
  h.update([...payload.images].sort().join("\u0001"));
  return h.digest("hex").slice(0, 24);
}

/**
 * 自动回复规则配置的形态定义（P3 预留）。
 * 当前**不会**被任何自动回复逻辑消费 —— 仅保证后续实施时配置结构稳定。
 */
export interface AutoReplyRule {
  /** 允许自动回复的联系人/群（精确名） */
  allowlist: string[];
  /** 有效时段（本地时间，24h 制），如 ["09:00","21:00"] */
  activeWindow: [string, string] | null;
  /** 单条会话最大连续回复轮数 */
  maxTurns: number;
}
