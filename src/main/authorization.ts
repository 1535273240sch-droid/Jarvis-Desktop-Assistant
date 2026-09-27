import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import { logger } from "./logger";
import { safetyManager } from "./safety";

/**
 * 能力授权（T07 第 6 节 + 项目书 P0 修复）。
 *
 * 修复点（对照项目书 §1 结论表「authorization」行）：
 * 1. 撤回成为**可持续生效状态**：撤回记录落盘（authorization-revoked.json），
 *    重启、截图或点击都不会自动恢复；重新授权必须由用户在面板显式操作。
 * 2. 屏幕读取、键鼠控制、对外发送是**分开的三类授权**；
 *    对外发送（external-send）永不自动授予。
 * 3. 不再提供 ensureAutoAuthorized() 启动自动授权 —— 旧版"启动即全量授权"
 *    与"撤回后不得自动恢复"直接冲突。已存在的授权记录视为用户显式选择，
 *    迁移时原样保留。
 */

/** 授权说明版本：文案变更后需重新取得同意 */
export const CONSENT_VERSION = 2;

/** 需要授权的能力。external-send 为对外通信类，与键鼠分列 */
export type Capability = "screen-capture" | "mouse-control" | "keyboard-control" | "external-send";

/** 从未授权（首次使用）：面板需要展示首次授权引导 */
export type AuthzState =
  | { state: "none" }
  | { state: "granted"; scope: Capability[]; grantedAt: string }
  | { state: "partial"; scope: Capability[]; grantedAt: string }
  | { state: "revoked"; scope: Capability[]; revokedAt: string; remaining: Capability[] };

export const CONSENT_TEXT = `Jarvis 需要你的明确授权才能使用以下高敏感能力：

1. 屏幕录制：截取你的屏幕或当前窗口画面，用于「看屏幕」类请求
2. 鼠标控制：移动并点击鼠标
3. 键盘控制：向当前窗口输入文字或按键

说明：
· 截图仅在你主动要求（或说话触发）时发生，不会持续录屏
· 所有截图、点击、输入都会写入本地审计日志
· 你可以随时按 Ctrl+Alt+X 全局急停，中断一切自动化操作
· 密码、验证码等敏感输入默认禁止由助手代填
· 你可以在设置中随时撤回本次授权（撤回后重启也不会自动恢复）

是否同意授权以上能力？`;

function userDataDir(): string {
  try {
    return app?.getPath("userData") || process.cwd();
  } catch {
    return process.cwd();
  }
}

function consentPath(): string {
  return path.join(userDataDir(), "authorization.json");
}

function revocationPath(): string {
  return path.join(userDataDir(), "authorization-revoked.json");
}

interface AuthorizationRecord {
  consentVersion: number;
  grantedAt: string;
  scope: Capability[];
}

interface RevocationRecord {
  revokedAt: string;
  /** 被撤回的能力（持久化：重启后依旧生效） */
  revoked: Capability[];
}

function readJson<T>(p: string): T | null {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
  } catch {
    return null;
  }
}

/** 读取当前授权；从未授权或版本过期返回 null（撤回记录单独读取） */
export function getAuthorization(): AuthorizationRecord | null {
  const rec = readJson<AuthorizationRecord>(consentPath());
  if (!rec || rec.consentVersion !== CONSENT_VERSION) return null;
  return rec;
}

function getRevocation(): RevocationRecord | null {
  return readJson<RevocationRecord>(revocationPath());
}

/** 某项能力当前是否有效授权（= 已授予 且 未被撤回） */
export function isAuthorized(cap: Capability): boolean {
  const rec = getAuthorization();
  if (!rec || !rec.scope.includes(cap)) return false;
  const rev = getRevocation();
  if (rev && rev.revoked.includes(cap)) return false;
  return true;
}

/** 面板/诊断用的授权总览 */
export function getAuthzState(): AuthzState {
  const rev = getRevocation();
  const rec = getAuthorization();
  const scope = rec?.scope ?? [];
  const remaining = rev ? scope.filter((c) => !rev.revoked.includes(c)) : scope;
  if (rev && rev.revoked.length > 0) {
    return { state: "revoked", scope: rev.revoked, revokedAt: rev.revokedAt, remaining };
  }
  if (!rec) return { state: "none" };
  return remaining.length === scope.length && scope.length > 0
    ? { state: "granted", scope, grantedAt: rec.grantedAt }
    : { state: "partial", scope: remaining, grantedAt: rec.grantedAt };
}

/**
 * 授予能力（面板显式操作）。会同时把对应能力从撤回记录中移除 ——
 * 重新授权是用户主动行为，这才允许覆盖持久化的撤回状态。
 */
export function grantAuthorization(scope: Capability[]): void {
  const caps = [...new Set(scope)];
  try {
    const old = getAuthorization();
    const merged: AuthorizationRecord = {
      consentVersion: CONSENT_VERSION,
      grantedAt: old?.grantedAt ?? new Date().toISOString(),
      scope: [...new Set([...(old?.scope ?? []), ...caps])],
    };
    fs.writeFileSync(consentPath(), JSON.stringify(merged, null, 2), "utf-8");
    // 从撤回记录中移除本次重新授予的能力
    const rev = getRevocation();
    if (rev) {
      const left = rev.revoked.filter((c) => !caps.includes(c));
      if (left.length) fs.writeFileSync(revocationPath(), JSON.stringify({ revokedAt: rev.revokedAt, revoked: left }, null, 2), "utf-8");
      else if (fs.existsSync(revocationPath())) fs.unlinkSync(revocationPath());
    }
    safetyManager.audit("authorize", { scope: caps });
    logger.info(`[Authorization] 用户已授权：${caps.join(", ")}`);
  } catch (e) {
    logger.error("[Authorization] 授权记录写入失败:", e);
  }
}

/** 撤回授权（可只撤回部分能力）。撤回持久化，重启后依然生效 */
export function revokeAuthorization(scope?: Capability[]): void {
  try {
    const rec = getAuthorization();
    const current = rec?.scope ?? (["screen-capture", "mouse-control", "keyboard-control"] as Capability[]);
    const targets = scope && scope.length ? scope : current;
    const rev = getRevocation();
    const merged: RevocationRecord = {
      revokedAt: new Date().toISOString(),
      revoked: [...new Set([...(rev?.revoked ?? []), ...targets])],
    };
    fs.writeFileSync(revocationPath(), JSON.stringify(merged, null, 2), "utf-8");
    // 同步收窄授权记录
    if (rec) {
      const left = rec.scope.filter((c) => !targets.includes(c));
      if (left.length) fs.writeFileSync(consentPath(), JSON.stringify({ ...rec, scope: left }, null, 2), "utf-8");
      else if (fs.existsSync(consentPath())) fs.unlinkSync(consentPath());
    }
    safetyManager.audit("authorize_revoke", { scope: targets });
    logger.warn(`[Authorization] 用户已撤回授权：${targets.join(", ")}（持久生效，重启后不会自动恢复）`);
  } catch (e) {
    logger.error("[Authorization] 撤回授权失败:", e);
  }
}

/** 一次性迁移：把旧版（v1 文案）下用户已明确授权的记录升级到 v2，保留其显式选择 */
export function migrateLegacyAuthorization(): void {
  try {
    const p = consentPath();
    if (!fs.existsSync(p)) return;
    const raw = readJson<AuthorizationRecord>(p);
    if (!raw) return;
    if (raw.consentVersion === 1 && Array.isArray(raw.scope) && raw.scope.length >= 3) {
      fs.writeFileSync(p, JSON.stringify({ ...raw, consentVersion: CONSENT_VERSION }, null, 2), "utf-8");
      logger.info("[Authorization] 已把 v1 授权记录升级到 v2（保留用户既有选择）");
    }
  } catch (e) {
    logger.warn("[Authorization] 旧授权迁移失败:", e);
  }
}

/** selftest 等显式诊断场景使用：整体授予三类高敏能力（不含 external-send） */
export function grantDiagnosticScope(): void {
  grantAuthorization(["screen-capture", "mouse-control", "keyboard-control"]);
}
