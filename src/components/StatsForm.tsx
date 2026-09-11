/**
 * 数据填写框 + 查询/计算按钮
 *
 * 决策 4：**Worker 离线时本区必须完整可用**。
 * 六个输入框与「计算得点」按钮永远可用；只有「查询」按钮会降级并给出提示。
 */

import type { RawStats } from '../types/weekly'
import { SectionLabel } from './ScoreViz'

export interface StatsFormProps {
  stats: RawStats
  onChange: (patch: Partial<RawStats>) => void
  /** B 站链接 / BV 号 / av 号 */
  biliInput: string
  onBiliInputChange: (v: string) => void

  onQuery: () => void
  onCalculate: () => void
  /** 清空六项数据与视频链接 */
  onClear: () => void

  /** 联网能力是否可用（Worker 是否在线） */
  apiAvailable: boolean
  querying: boolean

  /** 查询成功后的视频信息，用于回显 */
  videoTitle?: string
  videoCover?: string
  videoId?: string

  /** 「减去上期数据」 */
  canSubtract: boolean
  subtractLabel?: string
  onSubtract: () => void

  queryMessage?: { kind: 'info' | 'warn' | 'error'; text: string }
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
  biliInput,
  onBiliInputChange,
  onQuery,
  onCalculate,
  onClear,
  apiAvailable,
  querying,
  videoTitle,
  videoCover,
  videoId,
  canSubtract,
  subtractLabel,
  onSubtract,
  queryMessage,
}: StatsFormProps) {
  const hasAnyInput = (Object.keys(stats) as (keyof RawStats)[]).some((k) => stats[k] > 0)
  const canQuery = biliInput.trim().length > 0 && apiAvailable && !querying

  return (
    <div>
      <SectionLabel note={apiAvailable ? '自动填充可用' : '自动填充不可用'}>数据输入</SectionLabel>

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

      {/* B 站链接 / BV / av 自动填充 */}
      <div className="mt-3">
        <div className="text-[11px] mb-1 flex items-baseline justify-between">
          <span>B 站链接 / BV 号 / av 号</span>
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={biliInput}
            onChange={(e) => onBiliInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canQuery) onQuery()
            }}
            placeholder="https://www.bilibili.com/video/BV1WeZLBtEW1"
            spellCheck={false}
            className="nums grow min-w-0 border border-ink bg-transparent px-2 py-1.5 text-[12px] outline-none placeholder:text-muted focus:bg-ink focus:text-paper"
          />
          <button type="button" className="btn-flat shrink-0" onClick={onQuery} disabled={!canQuery}>
            {querying ? '查询中' : '查询'}
          </button>
        </div>

        {!apiAvailable ? (
          <p className="text-[10px] text-muted mt-1 leading-[1.6] mb-0">
            联网代理未上线，自动填充暂不可用 —— 请手动填写上方六项数据，计算功能不受影响。
          </p>
        ) : null}

        {queryMessage ? (
          <p
            className="text-[10px] mt-1 leading-[1.6] mb-0"
            style={{
              color: queryMessage.kind === 'error' ? 'var(--color-alert)' : 'var(--color-muted)',
            }}
          >
            {queryMessage.text}
          </p>
        ) : null}

        {/* 查询成功的视频回显 */}
        {videoId ? (
          <div className="mt-2 border border-ink px-2 py-1.5 flex items-start gap-2">
            {videoCover ? (
              <img
                src={videoCover}
                alt=""
                className="w-16 h-10 object-cover border border-ink shrink-0"
                referrerPolicy="no-referrer"
              />
            ) : null}
            <div className="min-w-0">
              <div className="nums text-[10px] text-muted">{videoId}</div>
              <div className="text-[11px] leading-snug break-words">{videoTitle}</div>
            </div>
          </div>
        ) : null}
      </div>

      {/* 操作按钮 */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" className="btn-flat btn-flat-dark" onClick={onCalculate} disabled={!hasAnyInput}>
          计算得点
        </button>

        <button type="button" className="btn-flat" onClick={onClear} disabled={!hasAnyInput && !biliInput}>
          清空数据
        </button>

        {canSubtract ? (
          <button type="button" className="btn-flat" onClick={onSubtract}>
            {subtractLabel ?? '减去上期数据'}
          </button>
        ) : null}
      </div>
    </div>
  )
}
