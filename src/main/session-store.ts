import { EventEmitter } from "node:events";
import { logger } from "./logger";
import type { ChatMessage } from "../common/types";

/**
 * 会话存储：聊天消息、模型上下文历史、以及供 30 分钟会话重建时迁移用的摘要。
 * 注意：音频不落盘（只保留文本与元数据）。
 */

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}`;
}

class SessionStore extends EventEmitter {
  private messages: ChatMessage[] = [];
  /** 供会话重建回注的历史（仅文本，序列化友好） */
  private contextHistory: Array<{ role: "user" | "assistant"; text: string }> = [];

  getMessages(): ChatMessage[] {
    return this.messages.map((m) => ({ ...m }));
  }

  addMessage(msg: Omit<ChatMessage, "messageId" | "timestamp"> & Partial<Pick<ChatMessage, "messageId" | "timestamp">>): ChatMessage {
    const full: ChatMessage = {
      messageId: msg.messageId || nextId(msg.role),
      role: msg.role,
      content: msg.content,
      thinking: msg.thinking,
      toolCall: msg.toolCall,
      timestamp: msg.timestamp || Date.now(),
    };
    this.messages.push(full);
    if (this.messages.length > 500) this.messages.splice(0, this.messages.length - 500);
    this.emit("message", full);
    return full;
  }

  /** 更新一条已存在的消息（流式增量渲染用） */
  updateMessage(messageId: string, patch: Partial<ChatMessage>): ChatMessage | null {
    const idx = this.messages.findIndex((m) => m.messageId === messageId);
    if (idx === -1) return null;
    this.messages[idx] = { ...this.messages[idx], ...patch };
    this.emit("update", this.messages[idx]);
    return this.messages[idx];
  }

  /** 创建一个空的助手消息占位，返回其 id，供后续流式填充 */
  createAssistantPlaceholder(): string {
    const m = this.addMessage({ role: "assistant", content: "" });
    return m.messageId;
  }

  addContext(role: "user" | "assistant", text: string): void {
    const t = (text || "").trim();
    if (!t) return;
    this.contextHistory.push({ role, text: t });
    if (this.contextHistory.length > 100) {
      this.contextHistory.splice(0, this.contextHistory.length - 100);
    }
  }

  getContextHistory(): ReadonlyArray<{ role: "user" | "assistant"; text: string }> {
    return this.contextHistory;
  }

  /**
   * 生成供会话重建用的上下文摘要。
   * 说明：这里做的是「截断式摘要」——保留最近 N 轮对话原文。
   * 之所以不用模型生成摘要，是为了不引入额外 API 调用与失败点；
   * 重建的目标是「不丢上下文」，保留原文最可靠。
   */
  buildMigrationDigest(maxTurns = 12): Array<{ role: "user" | "assistant"; text: string }> {
    const h = this.contextHistory;
    if (h.length <= maxTurns * 2) return [...h];
    const tail = h.slice(-maxTurns * 2);
    logger.info(`[SessionStore] 上下文迁移摘要：从 ${h.length} 条截取最近 ${tail.length} 条`);
    return tail;
  }

  clear(): void {
    this.messages = [];
    this.contextHistory = [];
    this.emit("cleared");
  }
}

export const sessionStore = new SessionStore();
