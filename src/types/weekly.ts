/**
 * 周刊虚拟歌手中文曲排行榜 · 数据模型
 *
 * 字段名与官方 JSON 严格对应，便于直接把接口响应喂进来。
 */

/** 六项原始数据（draft 中"数据填写框"的六个字段） */
export interface RawStats {
  /** 播放量 → play */
  play: number
  /** 点赞 → like */
  like: number
  /** 收藏 → favorite */
  favorite: number
  /** 硬币 → coin */
  coin: number
  /** 评论 → comment */
  comment: number
  /** 弹幕 → danmaku */
  danmaku: number
}

/** 周刊榜单单条视频（main_rank / second_rank / pick_up 通用） */
export interface WeeklyVideo extends RawStats {
  url: string
  avid: string
  coverurl?: string
  title: string
  pubdate: string
  /** 官方发布的最终得点（采集窗口时点的快照） */
  point: number
  share?: number
  rank?: number
  ext_rank?: Record<string, number>
}

/**
 * 一份周刊数据。
 *
 * 字段标注为可选的几项，是因为 Worker 会裁剪响应后再返回：
 * 只保留 `ranknum` / `generate_time` / `collect_*` / `main_rank` / `second_rank`，
 * 其余数组与时间戳不再返回。这样类型与线上真实数据保持一致。
 *
 * 重要：`main_rank` 是第 1~30 名，`second_rank` 是第 31~110 名，
 * **两段合起来才是完整榜单**。
 */
export interface WeeklyPeriod {
  version?: number
  /** 期号 */
  ranknum: number
  url?: string
  coverurl?: string
  pubdate?: string
  generate_time: string
  generate_timestamp?: number
  collect_start_time: string
  collect_end_time: string
  collect_start_time_timestamp?: number
  collect_end_time_timestamp?: number
  main_rank: WeeklyVideo[]
  second_rank?: WeeklyVideo[]
  super_hit?: WeeklyVideo[]
  pick_up?: WeeklyVideo[]
  oth_pickup?: WeeklyVideo[]
  'history-1-year'?: WeeklyVideo[]
  'history-10-year'?: WeeklyVideo[]
  ed?: Partial<WeeklyVideo>[]
  op?: Partial<WeeklyVideo>[]
  statistic?: Record<string, unknown>
  thanks_list?: unknown[]
}

/**
 * `/data/info/info.json` 的条目。
 *
 * 注意：Worker 会把该接口裁剪后再返回，只保留期号
 * （前端只用它取"最新期号"来定位缓存）。上游原始字段 url / coverurl / avid
 * 不在返回中，因此这里标注为可选，避免类型与运行时不一致。
 */
export interface RankListEntry {
  rank_num: string
  url?: string
  coverurl?: string
  avid?: string
}

/** `/data/info/info.json` 响应 */
export interface InfoJson {
  rank_list: RankListEntry[]
  generate_time?: string
  generate_timestamp?: number
}
