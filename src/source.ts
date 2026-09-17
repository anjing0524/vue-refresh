import stringify from 'fast-json-stable-stringify'
import type { RefreshSource } from './public-types.ts'

/**
 * 参数边界：固定资源定义与提交边界的一次准备。
 *
 * 根需求只有两条：**身份稳定**（同样参数值共享同一次请求）与**隔离**（任何持有者都改不到别人的参数）。
 * 因此这里只有三件事：复制一份、把副本编码成身份键、把值域钉死在编码忠实的范围内。
 * 编码交给 `fast-json-stable-stringify`（`JSON.stringify` 的确定性版本：对象键排序、数组保序）。
 *
 * 值域（ADR-52）：**对象型参数只能是普通对象或数组**。其余对象型值（`Date`／`Map`／`Set`／`RegExp`／
 * `Error`／`ArrayBuffer`／TypedArray 等）的内容藏在内部槽里，编码只看得到 `{}`——两个内容不同的参数
 * 会得到同一个身份，静默共享另一条查询的数据，故一律拒绝；`Date` 请传它的 ISO 字符串。
 * 标量沿用 JSON 语义：`-0` 与 `0` 同键、`NaN` / `Infinity` 按 `null`、`undefined` 字段按省略
 * （函数与 Proxy 这类复制不了的值在复制这一步就被拒绝，走不到编码）；复制不了的值由 `structuredClone`
 * 拒绝，编码不出的值（循环引用）在下面表达成 `null`。
 */

/** 一次已准备的请求参数。 */
export interface Parameters {
  /**
   * 提交边界复制的**框架私有副本**，不外发：`validate`、每一轮 `load`、每个接收者的 `display` 各拿一份
   * 副本，因此任何一个持有者都改不到身份键所描述的那份值（ADR-52）。
   */
  readonly args: object
  /** 完整参数值的稳定编码；key 表示数据范围，不是实例生存期 id。 */
  readonly key: string
}

/** 参数值域里的一个值：JSON 能忠实表示的值，外加 `undefined`（可选字段与显式缺省）。 */
type JsonValue = string | number | boolean | null | undefined | readonly JsonValue[] | { readonly [key: string]: JsonValue }

/**
 * 参数类型的值域约束。写成映射类型而不是 `Record<keyof P, …>`：后者会把可选字段变成必填，
 * 而这个形状保留可选与只读修饰符（ADR-52）。约束本身可以被改坏（例如把值域换成 `unknown`，
 * 那就等于不查），所以 `tests/types.ts` 里有两条反向探针盯着它。
 */
type JsonParameters<P> = { [K in keyof P]: JsonValue }

/** 声明一种固定业务资源。`definition` 必须是应用级常量；在渲染或提交中重建会得到新的共享身份。 */
export function defineRefresh<P extends JsonParameters<P>, T>(definition: RefreshSource<P, T>): RefreshSource<P, T> {
  // 不冻结调用方对象：框架只持有复制出来的私有副本。
  return Object.freeze({ load: definition.load, validate: definition.validate })
}

/**
 * 严格线（ADR-52）：对象型参数只能是普通对象或数组。
 *
 * 其余对象型值的内容藏在内部槽里（`Map.entries`、`Date` 的时刻、`RegExp` 的源串），
 * 编码只看得到 `{}`——两个内容不同的参数会得到同一个身份。这里在**复制之后**判：
 * `structuredClone` 已经把类实例的原型剥成普通对象，所以这条线只拦内容真的看不见的容器。
 */
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

/**
 * 稳定编码：不复制、不查值域、不执行 `validate`。
 *
 * 编码不出来（循环引用等）返回 `null`，而不是抛错：它是「这个参数没有身份」这个事实本身。
 * 这个 `null` 只在提交边界被当成非法参数拒绝（`submit` 的 `rejected`），因此坏参数只有一个出口。
 */
function parameterKey(input: object): string | null {
  try {
    return stringify(input)
  } catch {
    return null
  }
}

/**
 * 提交边界只执行一次：复制 → 值域检查 → 编码身份键 → 可选业务校验（消费者各拿副本）。
 * 值域不合格（对象型不是普通对象／数组）、`validate` 返回假值或抛错、复制失败（函数、Proxy）、
 * 编码不出身份（循环引用）都会让本次声明按非法参数拒绝，不产生实例或后台任务。
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
