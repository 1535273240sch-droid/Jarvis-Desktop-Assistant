// 宿主侧构建期「音频放大」参数。
//
// vendor/orb 是直接引入的第三方运行时，orb-audio.ts 里的 audioRules /
// audioFlowStrengths 必须保持上游原值（vendor 自带的 verify-audio 校验以及
// 球体编辑器自身行为都依赖它们），因此放大不写回 vendored 源码，而是在这里
// 独立声明一组放大后的常量：
//   scripts/generate-orb.mjs 生成 src/renderer/orb.html 时，用正则把导出模板
//   序列化出的 `const audioRules = [...];` / `const audioFlowStrengths = {...};`
//   整段替换为本模块的值——放大只发生在宿主构建期，且构建产物可复现。
//
// 各索引含义与 vendor/orb/src/orb-audio.ts 的 audioRules 注释一致：
//   [uniformIndex, 频段, 加法量(additive), 比例量(proportional), 上限(ceiling)]
//   3  = 全局形变强度     6  = 中频表面撕裂    7  = 低频轮廓涟漪
//   21 = 低频流场扭曲     10 = 高频细节抖动    14 = 全局流场强度
export const amplifiedAudioRules: ReadonlyArray<
  readonly [number, string, number, number, number]
> = [
  [3, "all", 0.35, 2.6, 14],
  [6, "mid", 4.2, 1.1, 22],
  [7, "low", 1.1, 1.9, 13],
  [21, "low", 1.05, 1.6, 5.5],
  [10, "high", 0.95, 0.6, 7],
  [14, "all", 0.25, 0.75, 9],
];

// 键为 uniform 索引 15（styleFlowIndexes，即流场风格分发索引），值为该风格的
// 音频放大倍率。坚持用字符串键的对象字面量声明：JSON.stringify 对「整数型键」
// 按升序输出，正好得到 9,10,11,14,19,21 的顺序，与导出模板期望的文本一致。
export const amplifiedAudioFlowStrengths: Readonly<Record<string, number>> = {
  "9": 2.6,
  "10": 2.1,
  "11": 2.1,
  "14": 2.4,
  "19": 2.9,
  "21": 2.2,
};
