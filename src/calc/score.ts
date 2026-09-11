/**
 * 计算内核 —— 纯函数，不依赖网络、不依赖浏览器。
 *
 * 公式来源：draft.md「计算规则」。已用官网 180 条真实记录回归验证
 * （735/734/733/730/700/650 六期，平均相对偏差 0.0699%，最差 0.5051%），
 * 残差来自"官方 point 是采集窗口时点快照、本工具用当前数据"的口径差异。
 *
 * 精度策略（见 plan.md §3.3）：内部全程 double 全精度，只在显示层四舍五入两位。
 */

import type { RawStats } from '../types/weekly'

/** 播放量分档阈值 */
export const PLAY_THRESHOLD = 10_000
/** 修正 A 上限 */
export const CORRECTION_A_MAX = 1
/** 修正 B 上限 */
export const CORRECTION_B_MAX = 50
/** 修正 C 上限 */
export const CORRECTION_C_MAX = 50
/** 修正 D 上限 */
export const CORRECTION_D_MAX = 1

export type BranchKey = 'le' | 'gt'

/**
 * 公式分支标识 —— 每个「二选一条件组」恰好对应一个 key，
 * 与右侧「完整计算逻辑」区里那组选项逐行对应，用于高亮**被选中的那一行**。
 *
 * 注意：「是否命中上限（抑制刷数据）」**不在这里**。
 * 上限是这条修正整体的性质，与走哪条分支正交，由 `CorrectionInfo.capped` 单独表达。
 * （早先版本把两者混编进同一个枚举，导致分支行无法正确高亮，已修正。）
 */
export type FormulaBranchKey =
  | 'basePlay.gt'
  | 'basePlay.le'
  | 'like.capped'
  | 'like.normal'
  | 'corrB.high'
  | 'corrB.low'
  | 'corrC.high'
  | 'corrC.low'
  | 'corrD.high'
  | 'corrD.low'

export interface CorrectionInfo {
  /** 计算出的修正值（未截断） */
  raw: number
  /** 实际采用的修正值 = min(raw, max) */
  value: number
  max: number
  /** 内部是否走了"高阶"分支（B: 收藏>硬币*2；C: 硬币>收藏；D: 收藏>硬币） */
  highBranch: boolean
  /** 是否命中上限（抑制刷数据）—— 与分支正交 */
  capped: boolean
  /** 输入是否不足（如 play=0），此时修正值被强制为 0（界面不提示，静默处理） */
  degenerate: boolean
  /** 距离上限的百分比（0~1） */
  ratioToMax: number
  /**
   * 该修正命中的条件分支标识。
   * `null` 表示这条修正**没有分支**（如修正 A 是单一公式），界面按普通行渲染。
   */
  formulaKey: FormulaBranchKey | null
}

export interface ScoreResult {
  /** 最终得点 */
  total: number
  /** 基础播放得点（分档后、乘修正前） */
  basePlay: number
  /** 播放分档命中情况 */
  playBranch: BranchKey
  /** 五类得点 */
  points: {
    play: number
    interaction: number
    favorite: number
    coin: number
    like: number
  }
  /** 四项修正 */
  corrections: {
    a: CorrectionInfo
    b: CorrectionInfo
    c: CorrectionInfo
    d: CorrectionInfo
  }
  /** 中间量，供"完整计算逻辑"区展示 */
  interactionCount: number
  /** 输入是否退化（play=0） */
  degenerate: boolean
  /**
   * 本轮**被选中**的公式分支集合。
   * 只含 active 态（未选中的选项就是朴素显示，无需额外标记），
   * 因此这是一个 Set 而非带状态的映射。
   */
  activeBranches: Set<FormulaBranchKey>
}

function safeDiv(numerator: number, denominator: number, fallback = 0): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return fallback
  const r = numerator / denominator
  return Number.isFinite(r) ? r : fallback
}

function clampish(n: number, fallback = 0): number {
  return Number.isFinite(n) ? n : fallback
}

/** 把任意输入规整成非负有限数 */
export function normalizeStats(input: Partial<RawStats> | null | undefined): RawStats {
  const pick = (v: unknown): number => {
    const n = typeof v === 'number' ? v : Number(v)
    if (!Number.isFinite(n) || n < 0) return 0
    return Math.floor(n)
  }
  return {
    play: pick(input?.play),
    like: pick(input?.like),
    favorite: pick(input?.favorite),
    coin: pick(input?.coin),
    comment: pick(input?.comment),
    danmaku: pick(input?.danmaku),
  }
}

/**
 * 计算最终得点。
 *
 * 最终得点 = 播放得点 + 互动得点 + 收藏得点 + 硬币得点 + 点赞得点
 */
export function calculateScore(input: Partial<RawStats> | null | undefined): ScoreResult {
  const { play, like, favorite, coin, comment, danmaku } = normalizeStats(input)

  // ── 基础播放得点 ────────────────────────────────────────────
  // 1. 若播放 > 10000，则基础播放得点 = 播放 * 0.5 + 5000
  // 2. 若播放 <= 10000，则基础播放得点 = 播放
  const playHighBranch = play > PLAY_THRESHOLD
  const basePlay = playHighBranch ? play * 0.5 + 5000 : play

  // play = 0 时修正 B / C / D 均除零 → 一律取 0（见 plan.md §3.2）
  const degenerate = play === 0

  // ── 修正 A ──────────────────────────────────────────────────
  // ((基础播放得点 + 收藏) / (基础播放得点 + 收藏 + (弹幕 + 评论) * 20)) ^ 2  上限 1
  const interactionCount = comment + danmaku
  const aDenom = basePlay + favorite + interactionCount * 20
  const aRaw = Math.pow(safeDiv(basePlay + favorite, aDenom, 0), 2)
  const aValue = Math.min(aRaw, CORRECTION_A_MAX)

  // ── 修正 B ──────────────────────────────────────────────────
  // 1. 若 收藏 > 硬币 * 2 → (硬币^2 / (播放 * 收藏)) * 1000
  // 2. 若 收藏 <= 硬币 * 2 → (收藏 / 播放) * 250                     上限 50
  const bHighBranch = favorite > coin * 2
  let bRaw: number
  let bDegenerate = false
  if (bHighBranch) {
    if (degenerate || favorite === 0) {
      bRaw = 0
      bDegenerate = true
    } else {
      bRaw = safeDiv(coin * coin, play * favorite, 0) * 1000
    }
  } else {
    if (degenerate) {
      bRaw = 0
      bDegenerate = true
    } else {
      bRaw = safeDiv(favorite, play, 0) * 250
    }
  }
  const bValue = Math.min(bRaw, CORRECTION_B_MAX)

  // ── 修正 C ──────────────────────────────────────────────────
  // 1. 若 硬币 > 收藏 → (收藏^2 / (播放 * 硬币)) * 250
  // 2. 若 硬币 <= 收藏 → (硬币 / 播放) * 250                          上限 50
  const cHighBranch = coin > favorite
  let cRaw: number
  let cDegenerate = false
  if (cHighBranch) {
    if (degenerate || coin === 0) {
      cRaw = 0
      cDegenerate = true
    } else {
      cRaw = safeDiv(favorite * favorite, play * coin, 0) * 250
    }
  } else {
    if (degenerate) {
      cRaw = 0
      cDegenerate = true
    } else {
      cRaw = safeDiv(coin, play, 0) * 250
    }
  }
  const cValue = Math.min(cRaw, CORRECTION_C_MAX)

  // ── 修正 D ──────────────────────────────────────────────────
  // 1. 若 收藏 > 硬币 → (硬币 / 播放) * 25
  // 2. 若 收藏 <= 硬币 → (收藏 / 播放) * 25                            上限 1
  const dHighBranch = favorite > coin
  const dRaw = degenerate ? 0 : safeDiv(dHighBranch ? coin : favorite, play, 0) * 25
  const dValue = Math.min(dRaw, CORRECTION_D_MAX)

  // ── 五类得点 ────────────────────────────────────────────────
  const playPoint = basePlay * dValue
  const interactionPoint = interactionCount * aValue * 15
  const favoritePoint = favorite * bValue
  const coinPoint = coin * cValue
  // 点赞得点：点赞 > 硬币 * 2 → 硬币 * 2；否则 → 点赞
  const likeCapped = like > coin * 2
  const likePoint = likeCapped ? coin * 2 : like

  const total = playPoint + interactionPoint + favoritePoint + coinPoint + likePoint

  const mkCorrection = (
    raw: number,
    value: number,
    max: number,
    highBranch: boolean,
    formulaKey: FormulaBranchKey | null,
    degen = false,
  ): CorrectionInfo => ({
    raw: clampish(raw),
    value: clampish(value),
    max,
    highBranch,
    // 上限判定必须用截断前的原始值，否则恒为 false
    capped: clampish(raw) > max,
    degenerate: degen,
    ratioToMax: max > 0 ? Math.min(Math.max(clampish(value) / max, 0), 1) : 0,
    formulaKey,
  })

  // ── 被选中的分支集合 ────────────────────────────────────────
  // 退化（play=0）时仍照常标记分支：命中哪条条件与"代入后除零"是两件事，
  // 后者由 degenerate 静默处理，界面不做提示。
  const activeBranches = new Set<FormulaBranchKey>([
    playHighBranch ? 'basePlay.gt' : 'basePlay.le',
    likeCapped ? 'like.capped' : 'like.normal',
    bHighBranch ? 'corrB.high' : 'corrB.low',
    cHighBranch ? 'corrC.high' : 'corrC.low',
    dHighBranch ? 'corrD.high' : 'corrD.low',
  ])

  return {
    total: clampish(total),
    basePlay: clampish(basePlay),
    playBranch: playHighBranch ? 'gt' : 'le',
    points: {
      play: clampish(playPoint),
      interaction: clampish(interactionPoint),
      favorite: clampish(favoritePoint),
      coin: clampish(coinPoint),
      like: clampish(likePoint),
    },
    corrections: {
      a: mkCorrection(aRaw, aValue, CORRECTION_A_MAX, false, null),
      b: mkCorrection(
        bRaw,
        bValue,
        CORRECTION_B_MAX,
        bHighBranch,
        bHighBranch ? 'corrB.high' : 'corrB.low',
        bDegenerate,
      ),
      c: mkCorrection(
        cRaw,
        cValue,
        CORRECTION_C_MAX,
        cHighBranch,
        cHighBranch ? 'corrC.high' : 'corrC.low',
        cDegenerate,
      ),
      d: mkCorrection(
        dRaw,
        dValue,
        CORRECTION_D_MAX,
        dHighBranch,
        dHighBranch ? 'corrD.high' : 'corrD.low',
        degenerate,
      ),
    },
    interactionCount,
    degenerate,
    activeBranches,
  }
}

/** 显示用：四舍五入到两位小数 */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100) / 100
}

/**
 * 显示用取整。得点量级很大，两位小数在界面上没有信息量，
 * 因此得点用整数显示，修正值用两位小数显示。
 */
export function round0(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round(n)
}
