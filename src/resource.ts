import type { Parameters } from './source.ts'

/** 一个身份（`URL ＋ 参数值`）自己的全部状态与判定：声明者、这一轮的结果产出了没有、到期与当前执行。
 * 它不持有核心、也不持有页面。 */

/** 一页报给核心的配置快照，同时就是这一页在核心里的登记。`every === null` ＝ 这一拍配置非法。 */
export interface Config {
  enabled: boolean
  every: number | null
  active: boolean
}

/** 一个「URL ＋ 参数值」的共享实例：这个身份的全部状态与判定。 */
export class Resource {
  /** 取数 URL：身份的一半，也是结果表分区的第一级。 */
  readonly url: string
  readonly parameters: Parameters
  /** 声明了本身份的配置（页面挂载期间一直算，暂停、失活、隐藏都不撤销）。 */
  readonly declarers = new Set<Config>()
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

  /** 环境允许：这一页激活、配置有效、浏览器可见（与「开启意愿」是两件事）。 */
  isPresent(config: Config, visible: boolean): boolean {
    return visible && config.every !== null && config.active
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
  isEligible(config: Config, visible: boolean): boolean {
    return this.isPresent(config, visible) && config.enabled
  }

  /** 有效间隔现算：有资格的声明者里最小的 `every`；没有就是 `Infinity`。 */
  private eligibleEvery(visible: boolean): number {
    let every = Infinity
    for (const config of this.declarers) {
      if (!this.isEligible(config, visible)) continue
      const value = config.every
      if (value !== null) every = Math.min(every, value)
    }
    return every
  }

  /** 下次到期时刻：`settledAt ＋ 当前最小间隔`；从未结算过的立即到期；没有有资格的人返回 `Infinity`。 */
  dueAt(now: number, visible: boolean): number {
    const every = this.eligibleEvery(visible)
    if (every === Infinity) return Infinity
    return this.settledAt === null ? now : this.settledAt + every
  }

  /** 结算一次执行：记下结算时刻并标上「这一轮的结果已经产出」（成功与失败都走它）。 */
  settle(at: number): void {
    this.settledAt = at
    this.produced = true
  }
}
