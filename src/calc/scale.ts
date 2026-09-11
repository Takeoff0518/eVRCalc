/**
 * 进度条刻度算法
 *
 * 两种用途：
 *  1. 叠加层进度条 —— 以 Top1 为基准，draft 规定 sqrt(本视频分项 / Top1 分项)，
 *     再套对数刻度进一步展开低分区。决策 1：对数刻度。
 *  2. 修正值进度条 —— 以上限（B/C=50，A/D=1）为基准的线性百分比。
 *     决策 3：不标注具体数值。
 */

/** 叠加层对数刻度的量程（跨越多少个数量级） */
export const OVERLAY_DECADES = 4

/**
 * 对数刻度：把 ratio ∈ (0, 1] 映射到 [0, 1]
 *
 * | ratio | decorades=4 下的进度 |
 * |-------|--------------------|
 * | 1      | 100%  与 Top1 持平 |
 * | 0.5    | 92.5% 差一倍 |
 * | 0.1    | 75%   差 10 倍 |
 * | 0.01   | 50%   差 100 倍 |
 * | 0.001  | 25%   差 1000 倍 |
 * | 1e-4   | 0%    差一万倍以上 |
 */
export function logScale(ratio: number, decades = OVERLAY_DECADES): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0
  if (ratio >= 1) return 1
  return 1 + Math.log10(ratio) / decades
}

/**
 * 叠加层进度：先按 draft 做 sqrt 压缩，再取对数刻度。
 * `top` 缺失或为 0 时返回 0（无法比较）。
 */
export function overlayProgress(value: number, top: number, decades = OVERLAY_DECADES): number {
  if (!Number.isFinite(value) || !Number.isFinite(top) || top <= 0 || value <= 0) return 0
  const ratio = Math.sqrt(value / top)
  return logScale(ratio, decades)
}

/** 修正值进度：value / max 的线性百分比，钳制在 [0, 1] */
export function ratioProgress(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0
  return Math.min(Math.max(value / max, 0), 1)
}

/** 百分比整数（用于界面显示） */
export function toPercent(fraction: number): number {
  return Math.round(Math.min(Math.max(fraction, 0), 1) * 100)
}
