import { ref } from 'vue'
import { defineRefresh, useRefresh } from '../src/index.ts'
import type { RefreshFailure, RefreshSource } from '../src/index.ts'
interface Params { account: string; symbol: string; filter?: { page: number } }
interface Quote { price: number }
// URL 与参数值决定身份；`Quote` 是**声明**的原始返回结构（框架不做响应转换，所以没有取数函数可绑定）。
const source = defineRefresh<Params, Quote>('/api/quote', { validate: p => p.account.length > 0 })
// Compile-only function: never executed outside component setup.
function contract() {
  const task = useRefresh(source, { enabled: ref(true), every: ref(1000) })
  // @ts-expect-error validation belongs to the fixed source definition
  useRefresh(source, { enabled: ref(true), every: 1000, validate: () => true })
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
  // 结算结果只报成功/失败/取消，不携带 DTO：数据只经 display 交付。
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
  // 首查就失败时从未成功过：`data` 与 `updatedAt` 都是 null，读取面必须自己判空（ADR-63）。
  const maybeQuote: Quote | null = task.display.value!.data
  void maybeQuote
  const maybeTime: number | null = task.display.value!.updatedAt
  void maybeTime
  // 失败是结果表那一格上的事实，读取面按自己的节拍取；成功后清空。
  const failure: RefreshFailure | null = task.display.value!.failure
  void failure
  // @ts-expect-error 失败是框架写的事实，页面不能改写它
  task.display.value!.failure = null
  // @ts-expect-error 失败不再由框架推送：`onError` 这一项已删除（ADR-63）
  useRefresh(source, { enabled: ref(true), every: ref(1000), onError: () => {} })
  // Source 的成员是方法，按双变比较：具体 Source 可以直接进入框架的擦除视图
  // （`RefreshSource<object, unknown>`），因此异构注册表不必在接收点保留类型断言。
  const erased: RefreshSource<object, unknown> = source
  void erased
  // 反向的代价换了个位置：擦除视图仍然可以注册，但读出来的数据收不窄成具体 DTO。
  const erasedTask = useRefresh(erased, { enabled: ref(true), every: ref(1000) })
  // @ts-expect-error 擦除视图的 display.data 是 unknown，不能当 Quote 用
  const erasedPrice: number = erasedTask.display.value!.data!.price
  void erasedPrice
}
// @ts-expect-error 定义必须给出 URL：它是身份的一半，缺了就无法与其它资源区分
defineRefresh<Params, Quote>({ validate: () => true })
// 参数值域（ADR-52）：对象型只能是普通对象或数组。这两条是**反向探针**——`JsonParameters` 的写法
// 换个形状（例如加 `readonly` 修饰符）会静默失效，那时这两条 `@ts-expect-error` 会变成「未使用的指令」而报错。
// @ts-expect-error Date 的内容对编码不可见，请传 ISO 字符串
defineRefresh<{ account: string; from: Date }, Quote>('/api/date')
// @ts-expect-error Map 的内容对编码不可见
defineRefresh<{ account: string; box: Map<string, number> }, Quote>('/api/map')
void contract
