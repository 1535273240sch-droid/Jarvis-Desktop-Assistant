import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";

class Logger {
  private logFilePath: string;

  constructor() {
    let logDir: string;
    try {
      logDir = path.join(app?.getPath("userData") || process.cwd(), "logs");
    } catch {
      logDir = path.join(process.cwd(), "logs");
    }
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    this.logFilePath = path.join(logDir, "jarvis-orb.log");
  }

  private write(level: string, message: string, ...args: any[]) {
    const timestamp = new Date().toISOString();
    const formattedArgs = args.length ? " " + args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ") : "";
    const logLine = `[${timestamp}] [${level}] ${message}${formattedArgs}\n`;
    
    // 控制台输出
    if (level === "ERROR") {
      console.error(logLine.trimEnd());
    } else if (level === "WARN") {
      console.warn(logLine.trimEnd());
    } else {
      console.log(logLine.trimEnd());
    }

    // 文件持久化
    try {
      fs.appendFileSync(this.logFilePath, logLine, "utf-8");
    } catch (e) {
      console.error("Failed to write to log file:", e);
    }
  }

  info(message: string, ...args: any[]) {
    this.write("INFO", message, ...args);
  }

  warn(message: string, ...args: any[]) {
    this.write("WARN", message, ...args);
  }

  error(message: string, ...args: any[]) {
    this.write("ERROR", message, ...args);
  }

  getLogPath(): string {
    return this.logFilePath;
  }
}

export const logger = new Logger();
