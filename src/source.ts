import stringify from 'fast-json-stable-stringify'
import type { RefreshSource } from './public-types.ts'

/**
 * 参数边界：固定资源定义（`defineRefresh`）与提交边界的一次准备（`prepareParameters`）。
 *
 * 两条根需求是**身份稳定**（同样参数值共享同一次请求）与**隔离**（任何持有者都改不到别人的参数）；
 * 值域、标量语义与「为什么对象型只收普通对象或数组」见 DESIGN §4.1。
 */

/** 一次已准备的请求参数。 */
export interface Parameters {
  /** 提交边界复制的**框架私有副本**，不外发；每个消费者（`validate`／`load`／`display`）各拿一份副本。 */
  readonly args: object
  /** 完整参数值的稳定编码；key 表示数据范围，不是实例生存期 id。 */
  readonly key: string
}

/** 参数值域里的一个值：JSON 能忠实表示的值，外加 `undefined`（可选字段与显式缺省）。 */
type JsonValue = string | number | boolean | null | undefined | readonly JsonValue[] | { readonly [key: string]: JsonValue }

/**
 * 参数类型的值域约束：`P` 的每个字段都必须落在 `JsonValue` 里。
 *
 * 写成同态映射类型而不是 `Record<keyof P, …>`（后者会把可选字段变成必填）；`tests/types.ts` 里有反向探针。
 */
type JsonParameters<P> = { [K in keyof P]: JsonValue }

/** 声明一种固定业务资源。`definition` 必须是应用级常量；在渲染或提交中重建会得到新的共享身份。 */
export function defineRefresh<P extends JsonParameters<P>, T>(definition: RefreshSource<P, T>): RefreshSource<P, T> {
  // 不冻结调用方对象：框架只持有复制出来的私有副本。
  return Object.freeze({ load: definition.load, validate: definition.validate })
}

/** 值域检查：对象型参数只能是普通对象或数组——`Date`／`Map`／`Set`／`RegExp`／`ArrayBuffer` 这类容器一律拒绝。 */
function assertJsonValue(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) return // 循环引用交给编码去拒绝，这一趟只查值域。
  seen.add(value)
  const prototype: unknown = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    const name = (value as { constructor?: { name?: string } }).constructor?.name ?? '该类值'
    throw new TypeError(`参数只能是普通对象、数组与 JSON 标量；不支持 ${name}`)
  }
  for (const child of Object.values(value)) assertJsonValue(child, seen)
}

/** 把参数编码成身份键；标量沿用 JSON 语义（`-0` ≡ `0`，`NaN`／非有限数按 `null`），编码不出来时返回 `null`。 */
function parameterKey(input: object): string | null {
  try {
    return stringify(input)
  } catch {
    return null
  }
}

/**
 * 提交边界只执行一次：复制 → 值域检查 → 编码身份键 → 可选业务校验（消费者各拿副本）。
 *
 * 四步中任何一步失败（值域不合格、`validate` 返回假值或抛错、复制失败、编码不出身份）都抛错，
 * 由 `submit` 按非法参数拒绝，不产生实例或后台任务。
 */
export function prepareParameters(input: object, source?: RefreshSource<object, unknown>): Parameters {
  const args: object = structuredClone(input)
  assertJsonValue(args, new WeakSet())
  // 编码只有这一处入口：`parameterKey` 与提交边界共用同一条规则。
  const key = parameterKey(args)
  if (key === null) throw new TypeError('参数无法稳定编码：存在循环引用或无法序列化的值')
  if (source?.validate) {
    // 框架私有那份不外发：`validate` 拿到自己的副本，改不到身份键所描述的那份值（ADR-52）。
    const valid: unknown = source.validate(structuredClone(args))
    if (typeof valid !== 'boolean') {
      // 返回 Promise 属于契约违约：同步抛错是给调用方的主信号，那个 Promise 也要观察掉，避免未处理拒绝。
      void Promise.resolve(valid).catch(() => {})
      throw new TypeError('validate 必须同步返回布尔值')
    }
    if (!valid) throw new TypeError('参数未通过 validate 校验')
  }
  return { args, key }
}
