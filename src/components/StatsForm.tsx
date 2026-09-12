/**
 * 数据填写框 + 清空按钮
 *
 * 六项数据可以手动填写，也可以从 B 站获取（点「获取」或榜单里的「填入」）。
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

  /** 清空六项数据 */
  onClear: () => void

  /** 已获取的数据（用于显示取数时间与来源） */
  biliStats?: BiliStats
  /** 正在取数 */
  biliLoading?: boolean
  /** 取数失败的原因（已翻译成可操作的说法） */
  biliError?: string
  /** 点「获取」：把输入框内容交给上层解析 */
  onBiliFetch?: (input: string) => void
  /** 重试上一次的取数（失败后出现） */
  onBiliRetry?: () => void
  /** 后端地址，显示在报错信息下方便于排查 */
  apiBase?: string
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
  onClear,
  biliStats,
  biliLoading,
  biliError,
  onBiliFetch,
  onBiliRetry,
  apiBase,
}: StatsFormProps) {
  const hasAnyInput = (Object.keys(stats) as (keyof RawStats)[]).some((k) => stats[k] > 0)
  const [input, setInput] = useState('')

  // 注意：**不因为一次取数失败就收起这个区块**。
  // 早先的版本会在失败后隐藏整块，结果是「点一下就没了」，用户既看不到原因
  // 也无法重试。现在无论成功失败都留着，失败了就明说失败在哪。
  const showFetch = Boolean(onBiliFetch)

  const submit = () => {
    if (!onBiliFetch || biliLoading) return
    const v = input.trim()
    if (!v) return
    onBiliFetch(v)
  }

  return (
    <div>
      <SectionLabel>数据输入</SectionLabel>

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

      {/* ── 从 B 站获取 ───────────────────────────────────────────── */}
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
              placeholder="粘贴视频链接 / BV 号 / av 号，或点下方榜单里的「填入」"
              className="min-w-0 flex-1 border border-ink bg-transparent px-2 py-1.5 text-[11px] outline-none focus:bg-ink focus:text-paper"
            />
            <button
              type="button"
              className="btn-flat shrink-0"
              onClick={submit}
              disabled={biliLoading || !input.trim()}
            >
              {biliLoading ? '获取中…' : '获取'}
            </button>
            {biliError && onBiliRetry ? (
              <button type="button" className="btn-flat shrink-0" onClick={onBiliRetry} disabled={biliLoading}>
                重试
              </button>
            ) : null}
          </div>

          <div className="mt-1.5 text-[10px] leading-[1.6]">
            {biliError ? (
              <div style={{ color: 'var(--color-alert)' }}>
                <div>取数失败：{biliError}</div>
                {apiBase ? (
                  <div className="text-muted mt-0.5">
                    当前后端地址 <span className="nums">{apiBase}</span>
                    <span> · 可改站点根目录的 config.json 后刷新，无需重新部署</span>
                  </div>
                ) : null}
              </div>
            ) : biliLoading ? (
              <span className="text-muted">正在获取…</span>
            ) : biliStats ? (
              <span className="text-muted">
                已填入《{biliStats.title}》
                {' · '}
                数据获取于 <span className="nums">{formatFetchedAt(biliStats.fetchedAt)}</span>
                {biliStats.cache === 'stale' ? (
                  <span style={{ color: 'var(--color-alert)' }}>
                    {' '}
                    · 上游暂时不可用，这是上次获取的旧数据
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="text-muted">数据来自 B 站当前时刻的公开统计。</span>
            )}
          </div>
        </div>
      ) : null}

      {/* 「计算得点」按钮已移除：得点是随输入实时计算的，那个按钮实际只做了
          「滚动到结果区」这一件事，反而让人以为是它触发了计算。
          现在只留一个「清空数据」。 */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="btn-flat" onClick={onClear} disabled={!hasAnyInput}>
          清空数据
        </button>
      </div>
    </div>
  )
}
