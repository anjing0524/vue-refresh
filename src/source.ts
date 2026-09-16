import stringify from 'fast-json-stable-stringify'
import { observeRejection } from './diagnostics.ts'
import type { ReadonlySnapshot, RefreshLoadContext, RefreshSource } from './public-types.ts'

/**
 * 固定资源定义与参数边界。
 *
 * 这是框架唯一接触「业务定义」和「原始参数」的地方：
 * - `defineRefresh` 在应用启动时建立稳定的 Source 身份；
 * - `prepareParameters` 在提交边界把原始参数变成冻结快照和稳定键。
 * 核心执行只消费准备好的 Parameters，不再读原始参数，也不重跑业务校验。
 */

/** 一次已准备的请求参数。 */
export interface Parameters {
  /** 提交边界复制并深冻结的参数副本；请求、轮询、恢复共用这一份。 */
  readonly args: object
  /** 完整参数值的稳定编码；key 表示数据范围，不是 Resource 生存期 id。 */
  readonly key: string
}

/**
 * 内部擦除类型：公开的 `RefreshSource` 只带类型品牌，运行时只剩框架需要的两个回调。
 * Manager 与执行路径一律只依赖这个窄接口。
 */
export interface SourceRuntime {
  readonly load: (args: object, context: RefreshLoadContext) => Promise<unknown>
  readonly validate?: (args: object) => boolean
}

/**
 * 声明一种固定业务资源，提前绑定参数 interface、请求函数和可选同步校验。
 *
 * `validate` 属于资源定义而不是页面配置：所有使用方共用同一套业务规则。
 * definition 必须是应用级常量；在渲染或提交中重建会得到新的共享身份。
 */
export function defineRefresh<P extends object, T>(definition: {
  readonly load: (args: ReadonlySnapshot<P>, context: RefreshLoadContext) => Promise<T>
  readonly validate?: (args: ReadonlySnapshot<P>) => boolean
}): RefreshSource<P, T> {
  // 不冻结调用方对象，只冻结框架自己持有的这一份。
  const source = Object.freeze({ load: definition.load, validate: definition.validate })
  return source as unknown as RefreshSource<P, T>
}

/** 把公开 Source 还原为内部端口。品牌字段只在类型层存在，运行时是一次可解释的擦除。 */
export function sourceRuntime(source: object): SourceRuntime {
  return source as SourceRuntime
}

/**
 * 参数深度守卫：只为阻断循环与病态嵌套，**不是业务上限**。
 *
 * 真实参数是应用构造的 JSON 记录，这个值远大于任何真实容器路径；命中它只说明参数不可信
 * （循环引用或非 JSON 结构），因此按非法参数拒绝。框架不提供业务侧可配置的深度或字节上限：
 * 参数规模由应用自己决定，框架不因为键大而拒绝一次合法查询。
 */
const MAX_PARAMETER_DEPTH = 1_000

/**
 * 检查参数副本是否落在 JSON 值域内，并按需冻结。
 *
 * 输入是应用构造的可信 JSON 记录，不是任意或恶意的 JS 对象；因此只检查值域与循环，
 * 不做 schema、原型历史或属性描述符探测。深度从 1 起算，取最长容器路径。
 */
function checkJsonValue(value: unknown, depth: number, freeze: boolean): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return
  if (typeof value !== 'object') throw new TypeError('Parameters require JSON data')
  if (depth > MAX_PARAMETER_DEPTH) throw new RangeError('Parameters must be acyclic JSON data')
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Parameters require JSON records or arrays')
  }
  for (const child of Object.values(value)) checkJsonValue(child, depth + 1, freeze)
  if (freeze) Object.freeze(value)
}

/** 值域与循环守卫 → 稳定编码。没有字节上限：键多长只影响内存，不影响正确性。 */
function buildKey(input: unknown, freeze: boolean): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('Parameters must be a JSON record')
  }
  checkJsonValue(input, 1, freeze)
  return stringify(input)
}

/** 只读定位：计算参数键用于查找已有 Resource。不复制、不冻结、不执行 validate。 */
export function parameterKey(input: object): string {
  return buildKey(input, false)
}

/** `validate` 必须同步返回布尔值；返回 Promise 是调用方违约，抛错与诊断共用这句说明。 */
const ASYNC_VALIDATE = 'validate must return a synchronous boolean'

/**
 * 提交边界只执行一次：复制 → 检查值域与循环并冻结 → 稳定编码 → 可选业务校验。
 *
 * 轮询、生命周期恢复与历史交付都复用这里返回的 Parameters；
 * 任何一步失败都按 validation 处理，不产生运行实例或后台任务。
 */
export function prepareParameters(
  input: object,
  validate?: (args: object) => boolean,
): Parameters {
  const args: object = structuredClone(input)
  const key = buildKey(args, true)
  if (validate) {
    const valid = validate(args)
    if (typeof valid !== 'boolean') {
      // 返回 Promise 属于契约违约：同步抛错是给调用方的主信号，这个 Promise 的拒绝则走
      // 与 observer 一致的诊断出口——既不产生未处理拒绝，也不被静默吞掉。
      observeRejection(valid, ASYNC_VALIDATE)
      throw new TypeError(ASYNC_VALIDATE)
    }
    if (!valid) throw new TypeError('Parameter validation failed')
  }
  return { args, key }
}
