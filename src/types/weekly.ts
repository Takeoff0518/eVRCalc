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

/** 一份周刊数据（{期数}.json 与 latest.json 结构一致） */
export interface WeeklyPeriod {
  version: number
  /** 期号 */
  ranknum: number
  url: string
  coverurl: string
  pubdate: string
  generate_time: string
  generate_timestamp: number
  collect_start_time: string
  collect_end_time: string
  collect_start_time_timestamp: number
  collect_end_time_timestamp: number
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

/** `/data/info/info.json` 的条目 */
export interface RankListEntry {
  rank_num: string
  url: string
  coverurl: string
  avid: string
}

/** `/data/info/info.json` 响应 */
export interface InfoJson {
  rank_list: RankListEntry[]
  generate_time: string
  generate_timestamp: number
}
