import { ref } from 'vue'
import { useRefresh } from '../src/index.ts'
interface Params { account: string; symbol: string; filter?: { page: number } }
interface Quote { price: number }
// URL 与参数值决定身份；`Quote` 是**声明**的原始返回结构（框架不做响应转换，所以没有取数函数可绑定）。
// 资源声明现在就是 URL 字符串本身：参数类型 `P` 与结果类型 `T` 在 `useRefresh` 调用上写明（ADR-74）。
const source = '/api/quote'
// Compile-only function: never executed outside component setup.
function contract() {
  const task = useRefresh<Params, Quote>(source, { enabled: ref(true), every: ref(1000) })
  task.submit({ account: 'demo', symbol: 'A', filter: { page: 1 } })
  // @ts-expect-error missing required interface field
  task.submit({ account: 'demo' })
  // @ts-expect-error incorrect field type
  task.submit({ account: 'demo', symbol: 2 })
  // @ts-expect-error tuple API was explicitly removed
  task.submit([{ account: 'demo', symbol: 'A' }])
  // 刷新不带参数：参数身份只来自已声明的 submission。
  // @ts-expect-error refresh takes no DTO argument
  task.refresh({ account: 'demo', symbol: 'A' })
  const settled = task.refresh()
  // `refresh` 没有回执（U14）：它连结算结果都不返回，成功与失败都只经 display。
  // @ts-expect-error the settlement result carries no DTO
  settled.then(result => result.data)
  // @ts-expect-error status is a closed union
  settled.then(result => result.status === 'done')
  // @ts-expect-error display is read only
  task.display.value = null
  // @ts-expect-error nested display data is read only
  task.display.value!.data!.price = 2
  // 正面探针：声明在定义点的 `Quote` 仍然决定 `display` 的数据类型。
  const price: number = task.display.value!.data!.price
  void price
  // 首查就失败时从未成功过：`data` 是 null；`updatedAt` 是那一次请求的时刻，读取面必须自己判空（ADR-63、ADR-122）。
  const maybeQuote: Quote | null = task.display.value!.data
  void maybeQuote
  const maybeTime: number | null = task.display.value!.updatedAt
  void maybeTime
  // 失败与数据在同一个出口上（ADR-122）：判这笔结算看 `failed`，原因是 `error`。
  const failed: boolean = task.display.value!.failed
  const cause: unknown = task.display.value!.error
  void failed
  void cause
  // @ts-expect-error 页面侧只有一个读出口：失败没有自己的 `Ref`（ADR-122）
  void task.failure
  // @ts-expect-error 失败不再由框架推送：`onError` 这一项已删除（ADR-63）
  useRefresh<Params, Quote>(source, { enabled: ref(true), every: ref(1000), onError: () => {} })
  // 读取面不带版本号／代次／「由谁触发」的标记（§2.5）：这三个名字一旦被加进公开形状，这里会红。
  // @ts-expect-error 读取面没有版本号
  void task.display.value!.generation
  // @ts-expect-error 读取面没有代次
  void task.display.value!.epoch
  // @ts-expect-error 读取面没有「由谁触发」的标记
  void task.display.value!.triggeredBy
  // 框架不提供「正在刷新」这类实时状态（§2.5）：句柄与出口上都没有它。
  // @ts-expect-error 句柄上没有「正在刷新」这个状态
  void task.refreshing
  // @ts-expect-error 出口上没有「正在刷新」
  void task.display.value!.refreshing
  // 结果表不是包契约（§2.5）：包入口不导出它，页面侧只有一个只读出口。
  // @ts-expect-error 包入口不导出结果表
  type InternalStore = import('../src/index.ts').useRefreshStore
  void (null as unknown as InternalStore)

  // 擦除视图：类型参数写在调用上（`object` 是值域的最宽形态），异构注册表不必在接收点留类型断言；
  // 反向的代价是读出来的数据收不窄成具体 DTO。
  const erasedTask = useRefresh<object, unknown>(source, { enabled: ref(true), every: ref(1000) })
  // @ts-expect-error 擦除视图的 display.data 是 unknown，不能当 Quote 用
  const erasedPrice: number = erasedTask.display.value!.data!.price
  void erasedPrice
}
// @ts-expect-error URL 是身份的一半，必须给出（资源声明就是那个字符串，ADR-74）
useRefresh<Params, Quote>()
// 参数值域（ADR-52）：对象型只能是普通对象或数组。这两条是**反向探针**——`JsonParameters` 的写法
// 换个形状（例如加 `readonly` 修饰符）会静默失效，那时这两条 `@ts-expect-error` 会变成「未使用的指令」而报错。
// @ts-expect-error Date 的内容对编码不可见，请传 ISO 字符串
useRefresh<{ account: string; from: Date }, Quote>('/api/date', { enabled: ref(true), every: ref(1000) })
// @ts-expect-error Map 的内容对编码不可见
useRefresh<{ account: string; box: Map<string, number> }, Quote>('/api/map', { enabled: ref(true), every: ref(1000) })
void contract
