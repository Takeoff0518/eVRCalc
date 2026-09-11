/**
 * 数据填写框 + 计算/清空按钮
 *
 * 六项数据由用户手动填写。计算是纯客户端的，**永远不依赖网络**。
 */

import type { RawStats } from '../types/weekly'
import { SectionLabel } from './ScoreViz'

export interface StatsFormProps {
  stats: RawStats
  onChange: (patch: Partial<RawStats>) => void

  onCalculate: () => void
  /** 清空六项数据 */
  onClear: () => void
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

export function StatsForm({ stats, onChange, onCalculate, onClear }: StatsFormProps) {
  const hasAnyInput = (Object.keys(stats) as (keyof RawStats)[]).some((k) => stats[k] > 0)

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
