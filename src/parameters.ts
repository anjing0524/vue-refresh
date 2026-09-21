import stringify from 'fast-json-stable-stringify'

/** 参数边界：提交边界的一次准备（复制 → 值域检查 → 稳定键），以及身份键的拼拆
 * （`identityOf` / `splitIdentity`——稳定键只是身份的一半，另一半是 URL）。 */

/** 一次已准备的请求参数。 */
export interface Parameters {
  /** 提交边界复制的框架私有副本，不外发。 */
  readonly args: object
  /** 完整参数值的稳定编码；表示数据范围，不是实例生存期 id。 */
  readonly key: string
}

/** 参数值域里的一个值：JSON 能忠实表示的值，外加 `undefined`。
 *  注意 `undefined` 只对标量字段有意义：键值为 `undefined` 的对象字段会被稳定编码按 JSON 语义丢弃，
 *  因此 `{ a: undefined }` 与 `{}` 是**同一个身份**（重复声明幂等，不换内容），`display.args` 交付的是先到的那一份。 */
type JsonValue = string | number | boolean | null | undefined | readonly JsonValue[] | { readonly [key: string]: JsonValue }

/** 组件刷新的参数类型（`useRefresh` 的 `P`）：`P` 的每个字段都必须落在 `JsonValue` 里。 */
export type JsonParameters<P> = { [K in keyof P]: JsonValue }

/** 值域检查：对象型参数只能是普通对象或数组；`Date`／`Map`／`Set`／`RegExp`／`ArrayBuffer` 这类容器一律拒绝。 */
function assertJsonValue(value: unknown, seen: WeakSet<object>): void {
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) return // 循环引用交给编码去拒绝。
  seen.add(value)
  const prototype: unknown = Object.getPrototypeOf(value)
  // 数组必须原型恰为 `Array.prototype`（拒绝子类与被改过原型的数组），对象必须是普通对象（含 `null` 原型）。
  // `structuredClone` 本就会把数组子类归一成普通数组，这一条让检查不依赖那个副作用、函数自身契约自洽。
  if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
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

/** 身份键 `URL ＋ 参数值稳定键` 的字面形式（NUL 分隔）。注册表与结果表共用这一个键。 */
export function identityOf(url: string, key: string): string {
  return `${url}\u0000${key}`
}

/** 身份键拆回两级（`store.list()` 用）：分隔符取最后一个 NUL——键里的 NUL 一定被 JSON 编码转义，URL 里可能有。 */
export function splitIdentity(identity: string): { readonly url: string; readonly key: string } {
  const sep = identity.lastIndexOf('\u0000')
  return { url: identity.slice(0, sep), key: identity.slice(sep + 1) }
}
