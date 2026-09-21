/**
 * 坐标换算（T07 第 4 节，从 T07 任务目录移植的纯函数）。
 *
 * 这是「坐标换算错误导致误点」的防线，规则只有一条：
 *   视觉模型输出的坐标是 **图像像素空间**，必须先按截图的 region
 *   归一化，再映射到 **屏幕物理像素（虚拟桌面坐标）**。
 *
 * 多显示器：虚拟桌面左上角才是原点，主屏左边的屏坐标为负；
 * DPI：截图与输入控制都走物理像素，中间不引入任何逻辑像素换算。
 *
 * 单元测试：Jarvis 侧用 tools/ 下的断言脚本覆盖（见 docs/说明文档）；
 * 完整断言测试套件在 T07 任务目录 test/coordinate-mapping.test.ts。
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageMeta {
  /** 图像自身像素尺寸 */
  width: number;
  height: number;
  /** 该图像对应的屏幕物理区域 */
  region: Rect;
}

export interface MappedTarget {
  /** 屏幕物理像素坐标（虚拟桌面坐标） */
  point: Point;
  /** 模型给的原始图像坐标 */
  imagePoint: Point;
  /** 坐标是否被 clamp 过（clamp 过说明模型给的点不可信） */
  clamped: boolean;
  /** 换算说明（审计用） */
  note: string;
}

function rectRight(r: Rect): number {
  return r.x + r.width;
}

function rectBottom(r: Rect): number {
  return r.y + r.height;
}

export function rectContains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= rectRight(r) && p.y >= r.y && p.y <= rectBottom(r);
}

export function clampPoint(p: Point, r: Rect): Point {
  return {
    x: Math.min(Math.max(p.x, r.x), rectRight(r)),
    y: Math.min(Math.max(p.y, r.y), rectBottom(r)),
  };
}

/** 全部显示器的并集（虚拟桌面边界） */
export function virtualScreenBounds(monitors: Rect[]): Rect {
  if (!monitors.length) throw new Error("显示器列表为空");
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const m of monitors) {
    left = Math.min(left, m.x);
    top = Math.min(top, m.y);
    right = Math.max(right, rectRight(m));
    bottom = Math.max(bottom, rectBottom(m));
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** 图像像素坐标 → 屏幕物理像素坐标 */
export function imageToScreen(imagePoint: Point, image: ImageMeta): MappedTarget {
  if (!(image.width > 0) || !(image.height > 0)) {
    throw new Error(`图像尺寸非法 ${image.width}x${image.height}`);
  }
  const { region } = image;
  const raw: Point = {
    x: region.x + (imagePoint.x / image.width) * region.width,
    y: region.y + (imagePoint.y / image.height) * region.height,
  };
  const inside = rectContains(region, raw);
  const clamped = inside ? raw : clampPoint(raw, region);
  return {
    point: { x: Math.round(clamped.x), y: Math.round(clamped.y) },
    imagePoint,
    clamped: !inside,
    note: inside
      ? ""
      : `模型坐标 (${imagePoint.x}, ${imagePoint.y}) 超出图像 ${image.width}x${image.height}，已 clamp 到 region 内`,
  };
}
