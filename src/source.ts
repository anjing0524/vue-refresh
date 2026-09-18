import stringify from 'fast-json-stable-stringify'
import type { ReadonlySnapshot } from './public-types.ts'

/** 参数边界：提交边界的一次准备（复制 → 值域检查 → 编码身份键）。 */

/** 一次已准备的请求参数。 */
export interface Parameters {
  /** 提交边界复制的框架私有副本，不外发。 */
  readonly args: object
  /** 完整参数值的稳定编码；表示数据范围，不是实例生存期 id。 */
  readonly key: string
}

/** 参数值域里的一个值：JSON 能忠实表示的值，外加 `undefined`。 */
type JsonValue = string | number | boolean | null | undefined | readonly JsonValue[] | { readonly [key: string]: JsonValue }

/** 参数类型的值域约束：`P` 的每个字段都必须落在 `JsonValue` 里。 */
export type { JsonParameters }

/** 组件刷新的参数类型（`useRefresh` 的 `P`）。 */
type JsonParameters<P> = { [K in keyof P]: JsonValue }

/** 值域检查：对象型参数只能是普通对象或数组；`Date`／`Map`／`Set`／`RegExp`／`ArrayBuffer` 这类容器一律拒绝。 */
function assertJsonValue(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) return // 循环引用交给编码去拒绝。
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

/** 提交边界只执行一次：复制 → 值域检查 → 编码身份键。任一步失败都抛错，由 `submit` 按非法参数拒绝。 */
export function prepareParameters(input: object): Parameters {
  const args: object = structuredClone(input)
  assertJsonValue(args, new WeakSet())
  const key = parameterKey(args)
  if (key === null) throw new TypeError('参数无法稳定编码：存在循环引用或无法序列化的值')
  return { args, key }
}
