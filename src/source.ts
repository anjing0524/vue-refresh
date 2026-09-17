import type { ReadonlySnapshot, RefreshLoadContext, RefreshSource } from './public-types.ts'

/**
 * 参数边界：固定资源定义与提交边界的一次准备。
 *
 * 根需求只有两条：**身份稳定**（同样参数值共享同一次请求）与**快照隔离**（页面改草稿不影响已提交的身份）。
 * 因此这里只有两个各做一件事的函数：`canonical` 是纯编码，`deepFreeze` 是唯一一处副作用。
 *
 * 编码**不判断值合法不合法**——那是调用方的责任。它只保证不同的值不会得到同一个键：
 * `-0` 与 `0` 是同一个数（同一个键）；`NaN` / `Infinity` / `undefined` / 函数 / `BigInt` 各自成键；
 * 非普通记录对象（`Date` / `Map` / 类实例）带上构造器名，不与空记录合并。
 * 循环引用让递归耗尽调用栈，引擎抛出的 `RangeError` 由调用方处理。
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

/**
 * 稳定编码：对象键排序、数组保序。**纯函数**，不改动输入。
 *
 * `JSON.stringify` 无法重排对象键，所以排序只能自己走一遍——这就是它存在的全部理由。
 * 超出 JSON 值域的输入也各自得到自己的键（见文件头），因此不需要任何合法性判断。
 */
function canonical(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (typeof value !== 'object') return `${typeof value}:${String(value)}`
  return Array.isArray(value) ? canonicalArray(value) : canonicalRecord(value as Record<string, unknown>)
}

function canonicalArray(value: unknown[]): string {
  const items: string[] = []
  for (const item of value) items.push(canonical(item))
  return `[${items.join(',')}]`
}

/** 非普通记录对象带上构造器名：不拒绝（那是调用方的事），也不与空记录静默合并。 */
function canonicalRecord(value: Record<string, unknown>): string {
  const prototype = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null
  const tag = prototype === null || prototype === Object.prototype ? '' : `${prototype.constructor?.name ?? 'Object'}:`
  const entries: string[] = []
  for (const key of Object.keys(value).sort()) {
    entries.push(`${JSON.stringify(key)}:${canonical(value[key])}`)
  }
  return `${tag}{${entries.join(',')}}`
}

/** 冻结框架自己持有的副本（`structuredClone` 的产物，只有普通对象与数组）；调用方原对象不冻结。 */
function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
}

/** 只读定位：只编码，不复制、不冻结、不执行 `validate`。 */
export function parameterKey(input: object): string {
  return canonical(input)
}

/**
 * 提交边界只执行一次：复制 → 稳定编码 → 冻结副本 → 可选业务校验。
 * `validate` 返回假值或抛错、复制失败（例如传了 Proxy）、循环引用都会让本次声明按非法参数拒绝，
 * 不产生实例或后台任务。
 */
export function prepareParameters(input: object, validate?: (args: object) => boolean): Parameters {
  const args: object = structuredClone(input)
  const key = canonical(args)
  deepFreeze(args)
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
