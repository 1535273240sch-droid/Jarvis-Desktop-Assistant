/**
 * 视觉模型坐标输出的解析（T07 第 3 节，从 T07 任务目录 provider.ts 移植）。
 *
 * ⚠️ 事实前提（已查阶跃官方文档）：官方视觉模型**没有** grounding /
 *    bounding-box / 坐标输出接口。因此采用结构化文本约定：让模型在回复里
 *    附一段 JSON 给出目标在图像像素坐标系里的位置。这是文本输出，
 *    不猜测任何未文档化的接口字段；但它是模型估算，必须配合
 *    「高亮预览 + 人工确认」才能点击（安全序列由 desktop-control 保证）。
 */

export interface VisionTarget {
  x: number;
  y: number;
  label?: string;
  confidence?: number;
}

/** 坐标输出约定的 prompt 片段（与 parseVisionTarget 的解析规则一致） */
export function COORDINATE_CONTRACT(width: number, height: number): string {
  return `如果用户要求定位屏幕上的某个可点击元素，请在回复末尾另起一段输出 JSON：
{"target":{"x":<元素中心横坐标，图像像素>,"y":<元素中心纵坐标，图像像素>,"label":"<元素名称>","confidence":<0到1>}}
坐标原点是图像左上角，范围分别是 0 到 ${width} 与 0 到 ${height}。只输出你确信的元素；无法定位就不要输出这段 JSON。`;
}

/**
 * 从模型文本里解析定位 JSON。容错策略：
 *  - 优先找 ```json 代码块；其次找包含 target/x/y 的 {…} 片段；
 *  - 支持 {"target":{...}}、{"x":..,"y":..}、{"point":[x,y]} 三种形态；
 *  - 越界坐标直接拒绝信任（宁可没有定位也不要错误点击）。
 */
export function parseVisionTarget(text: string, imageWidth: number, imageHeight: number): VisionTarget | null {
  const candidates: string[] = [];

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/gi);
  if (fenced) {
    for (const block of fenced) {
      candidates.push(block.replace(/```(?:json)?/gi, "").trim());
    }
  }
  const braces = text.match(/\{[\s\S]*\}/g);
  if (braces) candidates.push(...braces);

  for (const raw of candidates) {
    let obj: Record<string, unknown> | null = null;
    try {
      const v = JSON.parse(raw);
      if (v && typeof v === "object" && !Array.isArray(v)) obj = v as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!obj) continue;

    const container = (obj.target && typeof obj.target === "object" ? obj.target : obj) as Record<string, unknown>;
    let x: number | undefined;
    let y: number | undefined;

    if (Array.isArray(container.point) && container.point.length >= 2) {
      x = Number(container.point[0]);
      y = Number(container.point[1]);
    } else if (Array.isArray(container.bbox) && container.bbox.length >= 4) {
      x = (Number(container.bbox[0]) + Number(container.bbox[2])) / 2;
      y = (Number(container.bbox[1]) + Number(container.bbox[3])) / 2;
    } else if (typeof container.x === "number" && typeof container.y === "number") {
      x = container.x;
      y = container.y;
    }

    if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    // 越界坐标拒绝信任
    if (x < 0 || y < 0 || x > imageWidth || y > imageHeight) continue;

    const target: VisionTarget = { x, y };
    if (typeof container.label === "string") target.label = container.label;
    if (typeof container.confidence === "number") target.confidence = container.confidence;
    return target;
  }
  return null;
}

/** 去掉坐标 JSON，保留自然语言描述（供语音播报） */
export function stripTargetJson(text: string): string {
  return text
    .replace(/```(?:json)?\s*[\s\S]*?```/gi, "")
    .replace(/\{[\s\S]*?"(?:target|x|y|point)"[\s\S]*?\}/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
