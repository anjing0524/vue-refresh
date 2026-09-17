import stringify from 'fast-json-stable-stringify'
import type { RefreshSource } from './public-types.ts'

/**
 * 参数边界：固定资源定义与提交边界的一次准备。
 *
 * 根需求只有两条：**身份稳定**（同样参数值共享同一次请求）与**快照隔离**（页面改草稿不影响已提交的身份）。
 * 因此这里只有三件事：复制一份、把副本编码成身份键、把副本深冻结。
 * 编码交给 `fast-json-stable-stringify`（`JSON.stringify` 的确定性版本：对象键排序、数组保序）。
 *
 * 框架**不判断参数值是否合法**——那是调用方的责任，编码沿用 JSON 语义：
 * `-0` 与 `0` 同键，`NaN` / `Infinity` 按 `null`，`undefined` 与函数字段按省略，`Date` 按其 ISO 字符串；
 * 复制不了的值（函数、Proxy）由 `structuredClone` 拒绝，编码不出的值（循环引用）在下面表达成 `null`。
 */

/** 一次已准备的请求参数。 */
export interface Parameters {
  /** 提交边界复制并深冻结的参数副本；请求、轮询、恢复共用这一份。 */
  readonly args: object
  /** 完整参数值的稳定编码；key 表示数据范围，不是实例生存期 id。 */
  readonly key: string
}

/** 声明一种固定业务资源。`definition` 必须是应用级常量；在渲染或提交中重建会得到新的共享身份。 */
export function defineRefresh<P extends object, T>(definition: RefreshSource<P, T>): RefreshSource<P, T> {
  // 不冻结调用方对象，只冻结框架自己持有的这一份。
  return Object.freeze({ load: definition.load, validate: definition.validate })
}

/** 冻结框架自己持有的副本（`structuredClone` 的产物，只有普通对象与数组）；调用方原对象不冻结。 */
function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
}

/**
 * 稳定编码：不复制、不冻结、不执行 `validate`。
 *
 * 编码不出来（循环引用等）返回 `null`，而不是抛错：它是「这个参数没有身份」这个事实本身。
 * 两个调用点各自决定怎么表达——读取点当成「查不到」，提交点当成非法参数拒绝。
 * 这样坏参数只有一个出口会变成错误（`submit` 的 `rejected` ＋ 通知），读取永远不需要 `try/catch`。
 */
export function parameterKey(input: object): string | null {
  try {
    return stringify(input)
  } catch {
    return null
  }
}

/**
 * 提交边界只执行一次：复制 → 编码身份键 → 冻结副本 → 可选业务校验。
 * `validate` 返回假值或抛错、复制失败（函数、Proxy）、编码不出身份（循环引用）都会让本次声明按非法参数拒绝，
 * 不产生实例或后台任务。
 */
export function prepareParameters(input: object, source?: RefreshSource<object, unknown>): Parameters {
  const args: object = structuredClone(input)
  // 编码只有这一处入口：`parameterKey` 与提交边界共用同一条规则。
  const key = parameterKey(args)
  if (key === null) throw new TypeError('参数无法稳定编码：存在循环引用或无法序列化的值')
  deepFreeze(args)
  if (source?.validate) {
    const valid: unknown = source.validate(args)
    if (typeof valid !== 'boolean') {
      // 返回 Promise 属于契约违约：同步抛错是给调用方的主信号，那个 Promise 也要观察掉，避免未处理拒绝。
      void Promise.resolve(valid).catch(() => {})
      throw new TypeError('validate 必须同步返回布尔值')
    }
    if (!valid) throw new TypeError('参数未通过 validate 校验')
  }
  return { args, key }
}
