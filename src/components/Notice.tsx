/**
 * 顶部/底部单条非模态提示条（决策 4：不弹窗、不遮挡、不阻塞）
 */

import type { ReactNode } from 'react'

export type NoticeKind = 'info' | 'warn' | 'error'

export interface NoticeProps {
  kind: NoticeKind
  children: ReactNode
  onDismiss?: () => void
}

const COLOR: Record<NoticeKind, string> = {
  info: 'var(--color-ink)',
  warn: 'var(--color-muted)',
  error: 'var(--color-alert)',
}

const TAG: Record<NoticeKind, string> = {
  info: 'INFO',
  warn: 'WARN',
  error: 'ERR',
}

export function Notice({ kind, children, onDismiss }: NoticeProps) {
  return (
    <div
      className="flex items-start gap-2 border px-2.5 py-1.5 text-[11px] leading-[1.6]"
      style={{ borderColor: COLOR[kind] }}
      role={kind === 'error' ? 'alert' : 'status'}
    >
      <span className="nums shrink-0" style={{ color: COLOR[kind] }}>
        [{TAG[kind]}]
      </span>
      <span className="grow">{children}</span>
      {onDismiss ? (
        <button
          type="button"
          className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-[11px] underline"
          onClick={onDismiss}
          aria-label="关闭提示"
        >
          关闭
        </button>
      ) : null}
    </div>
  )
}
