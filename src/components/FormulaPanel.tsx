/**
 * 「完整计算逻辑」区 —— 决策 2：**只放公式原文**，不做数值代入推导。
 *
 * 结构（本轮定稿）：
 * - **条件组**渲染为一个外层 Box，内含若干**互斥选项行**（`divide-y` 分隔）。
 *   被选中的那一行用「同色淡底 + 左侧 3px 实心竖条」标出，未选中的保持朴素
 *   （不弱化、不变灰），因为并列本身就表达了互斥。
 * - **无分支的项**（最终得点 / 播放得点 / 互动得点 / 收藏得点 / 硬币得点 / 修正 A）
 *   就是普通一行，不高亮。
 * - **上限**是这条修正整体的性质、与走哪条分支正交，因此放在 label 行右侧常显；
 *   命中时在组底追加一整行药红提示。
 */

import type { FormulaBranchKey, ScoreResult } from '../calc/score'
import { SectionLabel } from './ScoreViz'

type BranchSet = ScoreResult['activeBranches']

const C = {
  play: 'var(--color-play)',
  vibe: 'var(--color-vibe)',
  fav: 'var(--color-fav)',
  coin: 'var(--color-coin)',
  like: 'var(--color-like)',
} as const

/**
 * 命中高亮的不透明度。
 * 其余家族色用 10% 即可辨认，但点赞的家族色是纯黑（#000000），
 * 10% 在纸白底上几乎看不出，因此单独提高一档。
 */
const ACTIVE_TINT = 0.1
const ACTIVE_TINT_DARK = 0.16

/** 一个互斥选项 */
interface Opt {
  key: FormulaBranchKey
  cond: string
  formula: string
}

/** 一个区块：要么无分支（单条公式），要么是一组互斥选项 */
interface Block {
  label: string
  /** 无分支时的单条公式 */
  formula?: string
  /** 有分支时的互斥选项组 */
  options?: Opt[]
  /** 命中高亮时使用的配色家族；无则不高亮 */
  color?: string
  /**
   * 上限标注（显示在 label 行右侧）。
   * 这里保持**中性呈现**：封顶信号只在左侧修正 Box 里用药红表达，
   * 避免同一个状态在两处重复提示。
   */
  cap?: number
}

interface Group {
  title: string
  blocks: Block[]
}

function OptionRow({ opt, active, color }: { opt: Opt; active: boolean; color?: string }) {
  // 点赞的家族色是纯黑，需要更高一点的不透明度才看得清
  const tint = color === C.like ? ACTIVE_TINT_DARK : ACTIVE_TINT
  return (
    <div
      className="flex flex-col sm:flex-row sm:items-baseline gap-x-2 gap-y-0.5 px-2.5 py-1.5 relative"
      style={active ? { background: `color-mix(in srgb, ${color} ${tint * 100}%, transparent)` } : undefined}
    >
      {active ? (
        <span
          className="absolute hidden sm:block"
          style={{ top: 0, left: 0, width: 3, height: '100%', background: color }}
          aria-hidden="true"
        />
      ) : null}
      <span
        className="nums text-[11px] leading-[1.6] shrink-0 sm:w-[124px]"
        style={{ color: active ? undefined : 'var(--color-muted)' }}
      >
        {opt.cond}
      </span>
      <span className="nums text-[11px] leading-[1.6] break-words">{opt.formula}</span>
    </div>
  )
}

function BlockView({ block, branches }: { block: Block; branches: BranchSet }) {
  const isChoice = Array.isArray(block.options) && block.options.length > 0

  return (
    <div className="border border-ink">
      {/* label 行：作为区块标题，加粗以与下方公式正文区分层级 */}
      <div className="flex items-baseline justify-between gap-2 px-2.5 py-1.5">
        <span className="text-[11px] font-bold">{block.label}</span>
        {block.cap !== undefined ? (
          <span className="nums text-[10px] shrink-0 text-muted">上限 {block.cap}</span>
        ) : null}
      </div>

      {/* 内容：条件组 或 单条公式 */}
      <div className="border-t border-ink">
        {isChoice ? (
          <div className="divide-y divide-ink">
            {block.options!.map((o) => (
              <OptionRow
                key={o.key}
                opt={o}
                active={branches.has(o.key)}
                color={block.color}
              />
            ))}
          </div>
        ) : (
          <pre className="nums text-[11px] leading-[1.6] m-0 px-2.5 py-1.5 whitespace-pre-wrap font-normal">
            {block.formula}
          </pre>
        )}
      </div>

      {/* 修复：不再有末端提示行 —— 封顶信号只由左侧修正 Box 表达 */}
    </div>
  )
}

const VAR_MAP = [
  ['播放', 'play'],
  ['点赞', 'like'],
  ['收藏', 'favorite'],
  ['硬币', 'coin'],
  ['评论', 'comment'],
  ['弹幕', 'danmaku'],
]

function buildGroups(result?: ScoreResult): Group[] {
  const corr = result?.corrections

  return [
    {
      title: '基本公式',
      blocks: [
        {
          label: '最终得点',
          formula: '播放得点 + 互动得点 + 收藏得点 + 硬币得点 + 点赞得点',
        },
      ],
    },
    {
      title: '分项得点',
      blocks: [
        {
          label: '基础播放得点',
          color: C.play,
          options: [
            { key: 'basePlay.gt', cond: '播放 > 10000', formula: '播放 * 0.5 + 5000' },
            { key: 'basePlay.le', cond: '播放 <= 10000', formula: '播放' },
          ],
        },
        { label: '播放得点', formula: '基础播放得点 * 修正 D' },
        { label: '互动得点', formula: '(评论 + 弹幕) * 修正 A * 15' },
        { label: '收藏得点', formula: '收藏 * 修正 B' },
        { label: '硬币得点', formula: '硬币 * 修正 C' },
        {
          label: '点赞得点',
          color: C.like,
          options: [
            { key: 'like.capped', cond: '点赞 > 硬币 * 2', formula: '硬币 * 2' },
            { key: 'like.normal', cond: '点赞 <= 硬币 * 2', formula: '点赞' },
          ],
        },
      ],
    },
    {
      title: '修正值',
      blocks: [
        {
          label: '修正 A',
          formula:
            '((基础播放得点 + 收藏) / (基础播放得点 + 收藏 + (弹幕 + 评论) * 20)) ^ 2',
        },
        {
          label: '修正 B',
          color: C.fav,
          cap: corr?.b.max,
          options: [
            {
              key: 'corrB.high',
              cond: '收藏 > 硬币 * 2',
              formula: '(硬币 ^ 2 / (播放 * 收藏)) * 1000',
            },
            {
              key: 'corrB.low',
              cond: '收藏 <= 硬币 * 2',
              formula: '(收藏 / 播放) * 250',
            },
          ],
        },
        {
          label: '修正 C',
          color: C.coin,
          cap: corr?.c.max,
          options: [
            {
              key: 'corrC.high',
              cond: '硬币 > 收藏',
              formula: '(收藏 ^ 2 / (播放 * 硬币)) * 250',
            },
            {
              key: 'corrC.low',
              cond: '硬币 <= 收藏',
              formula: '(硬币 / 播放) * 250',
            },
          ],
        },
        {
          label: '修正 D',
          color: C.play,
          cap: corr?.d.max,
          options: [
            { key: 'corrD.high', cond: '收藏 > 硬币', formula: '(硬币 / 播放) * 25' },
            { key: 'corrD.low', cond: '收藏 <= 硬币', formula: '(收藏 / 播放) * 25' },
          ],
        },
      ],
    },
  ]
}

export function FormulaPanel({ result }: { result?: ScoreResult }) {
  const branches: BranchSet = result?.activeBranches ?? new Set<FormulaBranchKey>()
  const groups = buildGroups(result)

  return (
    <div>
      <SectionLabel note={result ? undefined : '公式原文'}>完整计算逻辑</SectionLabel>

      <div className="flex flex-col gap-4">
        {groups.map((g) => (
          <div key={g.title}>
            <div className="text-[10px] tracking-[0.1em] text-muted uppercase mb-1">{g.title}</div>
            <div className="flex flex-col gap-2">
              {g.blocks.map((b) => (
                <BlockView key={b.label} block={b} branches={branches} />
              ))}
            </div>
          </div>
        ))}

        <div>
          <div className="text-[10px] tracking-[0.1em] text-muted uppercase mb-1">变量对照</div>
          <div className="border border-ink px-2.5 py-2">
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px]">
              {VAR_MAP.map(([cn, en]) => (
                <div key={en} className="flex items-baseline justify-between">
                  <span>{cn}</span>
                  <span className="nums text-muted">{en}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="border border-ink px-2.5 py-2">
          <div className="text-[10px] tracking-[0.1em] text-muted uppercase mb-1">计算与显示精度</div>
          <p className="text-[11px] leading-[1.7] m-0">
            计算过程内部保持全精度，仅在显示时保留两位小数。
            <br />
            官方发布的 <span className="nums">point</span> 是采集窗口时点的快照，
            而本工具使用当前实时数据，因此结果与官方值存在约 0.1% 的固有偏差。
          </p>
        </div>
      </div>
    </div>
  )
}
