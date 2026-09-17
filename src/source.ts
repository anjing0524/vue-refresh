import type { ReadonlySnapshot, RefreshLoadContext, RefreshSource } from './public-types.ts'

/**
 * 参数边界：固定资源定义与提交边界的一次准备。
 *
 * 根需求只有两条：**身份稳定**（同样参数值共享同一次请求）与**快照隔离**（页面改草稿不影响已提交的
 * 身份）。因此这里只有一趟遍历：值域守卫、深度守卫、按需冻结与稳定编码在同一次递归里完成。
 */

/** 一次已准备的请求参数。 */
export interface Parameters {
  /** 提交边界复制并深冻结的参数副本；请求、轮询、恢复共用这一份。 */
  readonly args: object
  /** 完整参数值的稳定编码；key 表示数据范围，不是实例生存期 id。 */
  readonly key: string
}

/** 内部擦除类型：公开的 `RefreshSource` 只带类型品牌，运行时只剩框架需要的两个回调。 */
export interface SourceRuntime {
  readonly load: (args: object, context: RefreshLoadContext) => Promise<unknown>
  readonly validate?: (args: object) => boolean
}

/** 声明一种固定业务资源。`definition` 必须是应用级常量；在渲染或提交中重建会得到新的共享身份。 */
export function defineRefresh<P extends object, T>(definition: {
  readonly load: (args: ReadonlySnapshot<P>, context: RefreshLoadContext) => Promise<T>
  readonly validate?: (args: ReadonlySnapshot<P>) => boolean
}): RefreshSource<P, T> {
  // 不冻结调用方对象，只冻结框架自己持有的这一份。
  return Object.freeze({ load: definition.load, validate: definition.validate }) as unknown as RefreshSource<P, T>
}

/** 品牌字段只在类型层存在；运行时是一次可解释的擦除。 */
export function sourceRuntime(source: object): SourceRuntime {
  return source as SourceRuntime
}

/** 只为阻断循环与病态嵌套，**不是业务上限**（G01 已关闭：不因键大而拒绝合法查询）。 */
const MAX_PARAMETER_DEPTH = 1_000

/** 一趟完成：值域守卫 → 深度守卫 → 按需冻结 → 稳定编码。非法值按非法参数抛错。 */
function encode(value: unknown, depth: number, freeze: boolean): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return encodeNumber(value)
  if (typeof value !== 'object') throw new TypeError('Parameters require JSON data')
  if (depth > MAX_PARAMETER_DEPTH) throw new RangeError('Parameters must be acyclic JSON data')
  return Array.isArray(value)
    ? encodeArray(value, depth, freeze)
    : encodeRecord(value as Record<string, unknown>, depth, freeze)
}

function encodeNumber(value: number): string {
  if (!Number.isFinite(value) || Object.is(value, -0)) throw new TypeError('Parameters require JSON data')
  return String(value)
}

function encodeArray(value: unknown[], depth: number, freeze: boolean): string {
  const items: string[] = []
  for (const item of value) items.push(encode(item, depth + 1, freeze))
  if (freeze) Object.freeze(value)
  return `[${items.join(',')}]`
}

/** 对象按键排序编码，因此字段顺序不同仍共享同一个身份；数组保持原顺序。 */
function encodeRecord(value: Record<string, unknown>, depth: number, freeze: boolean): string {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Parameters require JSON records or arrays')
  }
  const entries: string[] = []
  for (const key of Object.keys(value).sort()) {
    entries.push(`${JSON.stringify(key)}:${encode(value[key], depth + 1, freeze)}`)
  }
  if (freeze) Object.freeze(value)
  return `{${entries.join(',')}}`
}

/** 只读定位：只编码，不复制、不冻结、不执行 `validate`。 */
export function parameterKey(input: object): string {
  return encode(input, 1, false)
}

/** 提交边界只执行一次：复制 → 守卫/冻结/编码 → 可选业务校验；任何一步失败都按非法参数拒绝。 */
export function prepareParameters(input: object, validate?: (args: object) => boolean): Parameters {
  const args: object = structuredClone(input)
  const key = encode(args, 1, true)
  if (validate) {
    const valid: unknown = validate(args)
    if (typeof valid !== 'boolean') {
      // 返回 Promise 属于契约违约：同步抛错是给调用方的主信号，那个 Promise 也要观察掉，避免未处理拒绝。
      void Promise.resolve(valid).catch(() => {})
      throw new TypeError('validate must return a synchronous boolean')
    }
    if (!valid) throw new TypeError('Parameter validation failed')
  }
  return { args, key }
}
