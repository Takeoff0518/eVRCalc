/**
 * 数据填写框 + 计算/清空按钮
 *
 * 六项数据可以手动填写，也可以从 B 站取回（点「取回数据」或榜单里的「填入」）。
 * 但**计算本身永远是纯客户端的** —— 后端不可用时手填照旧，功能不受影响。
 */

import { useState } from 'react'
import type { RawStats } from '../types/weekly'
import type { BiliStats } from '../lib/biliApi'
import { formatFetchedAt } from '../lib/biliApi'
import { SectionLabel } from './ScoreViz'

export interface StatsFormProps {
  stats: RawStats
  onChange: (patch: Partial<RawStats>) => void

  onCalculate: () => void
  /** 清空六项数据 */
  onClear: () => void

  /** 已取回的数据（用于显示取数时间与来源） */
  biliStats?: BiliStats
  /** 正在取数 */
  biliLoading?: boolean
  /** 取数失败的原因 */
  biliError?: string
  /** 点「取回数据」：把输入框内容交给上层解析 */
  onBiliFetch?: (input: string) => void
  /** 后端是否可用（不可用时整个取数区块隐藏） */
  biliAvailable?: boolean
}

interface FieldDef {
  key: keyof RawStats
  label: string
  hint: string
}

const FIELDS: FieldDef[] = [
  { key: 'play', label: '播放量', hint: 'play' },
  { key: 'like', label: '点赞', hint: 'like' },
  { key: 'favorite', label: '收藏', hint: 'favorite' },
  { key: 'coin', label: '硬币', hint: 'coin' },
  { key: 'comment', label: '评论', hint: 'comment' },
  { key: 'danmaku', label: '弹幕', hint: 'danmaku' },
]

export function StatsForm({
  stats,
  onChange,
  onCalculate,
  onClear,
  biliStats,
  biliLoading,
  biliError,
  onBiliFetch,
  biliAvailable,
}: StatsFormProps) {
  const hasAnyInput = (Object.keys(stats) as (keyof RawStats)[]).some((k) => stats[k] > 0)
  const [input, setInput] = useState('')

  const showFetch = Boolean(onBiliFetch) && biliAvailable !== false

  const submit = () => {
    if (!onBiliFetch || biliLoading) return
    const v = input.trim()
    if (!v) return
    onBiliFetch(v)
  }

  return (
    <div>
      <SectionLabel note="数据可在 B 站视频页直接查看">数据输入</SectionLabel>

      {/* 六个数据框：2 列 × 3 行，保持 4px 节奏 */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {FIELDS.map((f) => (
          <label key={f.key} className="flex flex-col gap-1">
            <span className="text-[11px] flex items-baseline justify-between">
              <span>{f.label}</span>
              <span className="nums text-[10px] text-muted">{f.hint}</span>
            </span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              value={stats[f.key] === 0 ? '' : String(stats[f.key])}
              placeholder="0"
              onChange={(e) => {
                const raw = e.target.value
                const n = raw === '' ? 0 : Math.max(0, Math.floor(Number(raw) || 0))
                onChange({ [f.key]: n } as Partial<RawStats>)
              }}
              className="nums w-full border border-ink bg-transparent px-2 py-1.5 text-[13px] outline-none focus:bg-ink focus:text-paper"
            />
          </label>
        ))}
      </div>

      {/* ── 从 B 站取回 ───────────────────────────────────────────── */}
      {showFetch ? (
        <div className="mt-2.5 border-t border-ink pt-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
              placeholder="粘贴视频链接 / BV 号 / av 号，或点右侧榜单里的「填入」"
              className="min-w-0 flex-1 border border-ink bg-transparent px-2 py-1.5 text-[11px] outline-none focus:bg-ink focus:text-paper"
            />
            <button
              type="button"
              className="btn-flat shrink-0"
              onClick={submit}
              disabled={biliLoading || !input.trim()}
            >
              {biliLoading ? '获取中…' : '取回数据'}
            </button>
          </div>

          <div className="mt-1.5 text-[10px] leading-[1.6] min-h-[15px]">
            {biliError ? (
              <span style={{ color: 'var(--color-alert)' }}>取数失败：{biliError}</span>
            ) : biliStats ? (
              <span className="text-muted">
                已填入《{biliStats.title}》
                {' · '}
                数据获取于 <span className="nums">{formatFetchedAt(biliStats.fetchedAt)}</span>
                {biliStats.cache === 'stale' ? (
                  <span style={{ color: 'var(--color-alert)' }}>
                    {' '}
                    · 上游暂时不可用，这是上次取回的旧数据
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="text-muted">
                取回的是时点快照，与官方 point 存在约 0.1% 的偏差。
              </span>
            )}
          </div>
        </div>
      ) : null}

      {/* 操作按钮 */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-flat btn-flat-dark"
          onClick={onCalculate}
          disabled={!hasAnyInput}
        >
          计算得点
        </button>

        <button type="button" className="btn-flat" onClick={onClear} disabled={!hasAnyInput}>
          清空数据
        </button>
      </div>
    </div>
  )
}
