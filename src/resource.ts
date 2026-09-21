import type { Parameters } from './source.ts'

/** 一个身份（`URL ＋ 参数值`）自己的全部状态与判定：声明者、这一轮的结果产出了没有、到期与当前执行。
 * 它不持有核心、也不持有页面。 */

/** 一页报给核心的配置快照，同时就是这一页在核心里的登记。`every === null` ＝ 这一拍配置非法；
 * `present` ＝ 环境允许（这一页激活且浏览器可见，由适配层合成后报进来）。
 * 注意：它**不是**调用方传入的 `RefreshOptions`——那是两个 `Ref` 的源头配置；本接口是核心持有的登记槽，
 * 适配层原地写、核心只读（ADR-66）。 */
export interface Config {
  enabled: boolean
  every: number | null
  present: boolean
}

/** 一个**身份**（`URL ＋ 参数值`）的全部状态与判定：声明者、这一轮的结果产出了没有、到期与当前执行。
 * 它不持有核心、也不持有页面；不是 URL 本身（URL 只是身份的一半），也不是网络资源。 */
export class Resource {
  /** 取数 URL：身份的一半，也是结果表分区的第一级。 */
  readonly url: string
  readonly parameters: Parameters
  /** 声明了本身份的配置（页面挂载期间一直算，暂停、失活、隐藏都不撤销）。 */
  readonly declarers = new Set<Config>()
  /** 「一次执行」由 `controller`／`produced`／`needsNext` 三个位联合表达（ADR-65 不设独立执行对象、
   *  ADR-70 不把两个布尔并成三态字段），合法组合与迁移点如下——读这三个位之前先对齐这张表：
   *  ① `controller === null`（无执行）⟹ `produced`／`needsNext` 必为 `false`；
   *  ② `controller !== null && !produced`：在队或在跑、结果还没产出（刷新命令落「用这一轮」分支）；
   *  ③ `controller !== null && produced`：结算到收尾之间（刷新命令落「补一轮」分支，置 `needsNext`）。
   *  迁移点各只有几处：`enqueue` 建把手；`settle` 置 `produced`；`core.refresh` 只在 ③ 上置 `needsNext`；
   *  `run` 的 finally 清 `controller`／`produced` 并消费 `needsNext`；`releaseIfUnused` 清 `controller`／`needsNext`。 */
  /** 这一轮的结果已经产出了没有（写表之前置起、一轮结束时清掉）。 */
  produced = false
  /** 产出之后又有人点过刷新：本轮结束后再排一次。 */
  needsNext = false
  /** 最近一次执行有结局的时刻（成功与失败都算）；`null` 表示从未结算过，因此立即到期。 */
  settledAt: number | null = null
  /** 这次执行的身份与取消把手；`null` ＝ 本实例此刻没有执行。 */
  controller: AbortController | null = null

  constructor(url: string, parameters: Parameters) {
    this.url = url
    this.parameters = parameters
  }

  /** 环境允许且配置有效（`refresh` 的入口闸口径）：`every !== null` 是周期有效，`config.present` 是环境允许。
   *  名字带 `AndValid` 是明说：它比字段 `present` 多判一项「配置有效」，两者不是同一个概念（§0.4／§3 U14）。 */
  isPresentAndValid(config: Config): boolean {
    return config.every !== null && config.present
  }

  /** 这个身份此刻有没有执行（在队或在跑）。 */
  hasExecution(): boolean {
    return this.controller !== null
  }

  /** 这次执行还是不是当前执行。 */
  isCurrent(controller: AbortController): boolean {
    return this.controller === controller
  }

  /** 还有人要它吗：还有声明者。 */
  isWanted(): boolean {
    return this.declarers.size > 0
  }

  /** 一个声明者此刻是否有资格取数：环境允许 ＋ 开启意愿为真。 */
  isEligible(config: Config): boolean {
    return this.isPresentAndValid(config) && config.enabled
  }

  /** 有效间隔现算：有资格的声明者里最小的 `every`；没有就是 `Infinity`。 */
  private eligibleEvery(): number {
    let every = Infinity
    for (const config of this.declarers) {
      if (!this.isEligible(config)) continue
      const value = config.every
      if (value !== null) every = Math.min(every, value)
    }
    return every
  }

  /** 下次到期时刻：`settledAt ＋ 当前最小间隔`；从未结算过的立即到期；没有有资格的人返回 `Infinity`。 */
  dueAt(now: number): number {
    const every = this.eligibleEvery()
    if (every === Infinity) return Infinity
    return this.settledAt === null ? now : this.settledAt + every
  }

  /** 结算一次执行：记下结算时刻并标上「这一轮的结果已经产出」（成功与失败都走它）。 */
  settle(at: number): void {
    this.settledAt = at
    this.produced = true
  }
}
