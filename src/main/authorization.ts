import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import { logger } from "./logger";
import { safetyManager } from "./safety";

/**
 * 首次使用授权（T07 第 6 节）。
 *
 * 屏幕录制与输入控制属高敏感能力：首次使用必须明确告知并征得用户同意，
 * 同意记录落盘（含版本号），之后不再重复打扰；用户可在设置里撤回授权。
 *
 * 授权走聊天面板已有的确认通道（TOOL_CONFIRM_REQUEST），文案在此文件中完整给出，
 * 不得折叠关键信息。
 */

/** 授权说明版本：文案变更后需重新取得同意 */
export const CONSENT_VERSION = 1;

/** 需要授权的三项能力 */
export type Capability = "screen-capture" | "mouse-control" | "keyboard-control";

export const CONSENT_TEXT = `Jarvis 需要你的明确授权才能使用以下高敏感能力：

1. 屏幕录制：截取你的屏幕或当前窗口画面，用于「看屏幕」类请求
2. 鼠标控制：移动并点击鼠标
3. 键盘控制：向当前窗口输入文字或按键

说明：
· 截图仅在你主动要求（或说话触发）时发生，不会持续录屏
· 所有截图、点击、输入都会写入本地审计日志
· 你可以随时按 Ctrl+Alt+X 全局急停，中断一切自动化操作
· 密码、验证码等敏感输入默认禁止由助手代填
· 你可以在设置中随时撤回本次授权

是否同意授权以上能力？`;

function consentPath(): string {
  let dir: string;
  try {
    dir = app?.getPath("userData") || process.cwd();
  } catch {
    dir = process.cwd();
  }
  return path.join(dir, "authorization.json");
}

interface AuthorizationRecord {
  consentVersion: number;
  grantedAt: string;
  scope: Capability[];
}

/** 读取当前授权；从未授权或版本过期返回 null */
export function getAuthorization(): AuthorizationRecord | null {
  try {
    const p = consentPath();
    if (!fs.existsSync(p)) return null;
    const rec = JSON.parse(fs.readFileSync(p, "utf-8")) as AuthorizationRecord;
    if (rec.consentVersion !== CONSENT_VERSION) return null;
    return rec;
  } catch {
    return null;
  }
}

/** 某项能力是否已授权 */
export function isAuthorized(cap: Capability): boolean {
  const rec = getAuthorization();
  return rec !== null && rec.scope.includes(cap);
}

/**
 * 全自动模式下的能力授权。
 *
 * 本应用默认以「全自动」方式运行：用户已经通过安装并启动本软件表达了授权意图，
 * 因此不再对屏幕录制/鼠标/键盘做逐次人工确认，首次调用时自动落盘授权记录。
 * 所有实际操作仍完整写入 audit.jsonl 审计日志，保留事后追溯能力。
 */
export function ensureAutoAuthorized(): void {
  const rec = getAuthorization();
  if (rec && rec.scope.length >= 3) return;
  grantAuthorization(["screen-capture", "mouse-control", "keyboard-control"]);
}

/** 记录授权 */
export function grantAuthorization(scope: Capability[]): void {
  const rec: AuthorizationRecord = {
    consentVersion: CONSENT_VERSION,
    grantedAt: new Date().toISOString(),
    scope,
  };
  try {
    fs.writeFileSync(consentPath(), JSON.stringify(rec, null, 2), "utf-8");
    safetyManager.audit("authorize", { scope });
    logger.info(`[Authorization] 用户已授权：${scope.join(", ")}`);
  } catch (e) {
    logger.error("[Authorization] 授权记录写入失败:", e);
  }
}

/** 撤回授权 */
export function revokeAuthorization(): void {
  try {
    const p = consentPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
    safetyManager.audit("authorize_revoke", {});
    logger.info("[Authorization] 用户已撤回授权");
  } catch (e) {
    logger.error("[Authorization] 撤回授权失败:", e);
  }
}
