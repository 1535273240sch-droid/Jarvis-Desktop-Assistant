import * as fs from "node:fs";
import * as path from "node:path";
import { app, screen } from "electron";
import { logger } from "./logger";

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

const DEFAULT_SIZE = 260;

export class WindowStore {
  private configPath: string;
  private state: WindowState;

  constructor() {
    let userDataDir: string;
    try {
      userDataDir = app?.getPath("userData") || process.cwd();
    } catch {
      userDataDir = process.cwd();
    }
    this.configPath = path.join(userDataDir, "orb-window-state.json");
    this.state = this.load();
  }

  private load(): WindowState {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (typeof parsed.width === "number" && typeof parsed.height === "number") {
          return parsed;
        }
      }
    } catch (e) {
      logger.warn("Failed to load saved window state, using defaults:", e);
    }
    return { width: DEFAULT_SIZE, height: DEFAULT_SIZE };
  }

  save(bounds: { x: number; y: number; width?: number; height?: number }) {
    this.state = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width || this.state.width || DEFAULT_SIZE,
      height: bounds.height || this.state.height || DEFAULT_SIZE,
    };
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.state, null, 2), "utf-8");
    } catch (e) {
      logger.error("Failed to save window state:", e);
    }
  }

  getValidatedBounds(): { x: number; y: number; width: number; height: number } {
    const width = this.state.width || DEFAULT_SIZE;
    const height = this.state.height || DEFAULT_SIZE;

    const primaryDisplay = screen.getPrimaryDisplay();
    const { workArea } = primaryDisplay;

    // 默认位置：屏幕右下角（留出一定边距）
    const defaultX = workArea.x + workArea.width - width - 40;
    const defaultY = workArea.y + workArea.height - height - 80;

    let targetX = this.state.x ?? defaultX;
    let targetY = this.state.y ?? defaultY;

    // 检查保存的位置是否在当前任意可用的显示器可视工作区内
    const displays = screen.getAllDisplays();
    const isVisible = displays.some(display => {
      const b = display.bounds;
      return (
        targetX >= b.x - width / 2 &&
        targetX <= b.x + b.width - width / 2 &&
        targetY >= b.y - height / 2 &&
        targetY <= b.y + b.height - height / 2
      );
    });

    if (!isVisible) {
      logger.info(`Saved window position (${targetX}, ${targetY}) is outside current screen area, resetting to default (${defaultX}, ${defaultY})`);
      targetX = defaultX;
      targetY = defaultY;
    }

    return { x: targetX, y: targetY, width, height };
  }
}

export const windowStore = new WindowStore();
