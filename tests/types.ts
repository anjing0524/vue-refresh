import { ref } from 'vue'
import { defineRefresh, useRefresh } from '../src/index.ts'
import type { RefreshSource } from '../src/index.ts'
interface Params { account: string; symbol: string; filter?: { page: number } }
interface Quote { price: number }
const source = defineRefresh<Params, Quote>({ validate: p => p.account.length > 0, async load(args) { return { price: args.symbol.length } } })
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
  task.display.value!.data.price = 2
  // Source 的成员是方法，按双变比较：具体 Source 可以直接进入框架的擦除视图
  // （`RefreshSource<object, unknown>`），因此异构注册表不必在接收点保留类型断言。
  const erased: RefreshSource<object, unknown> = source
  void erased
  // 反向不成立：擦除视图不能当具体 Source 用（结果类型 `unknown` 收不窄）。
  // @ts-expect-error the erased view cannot be used as a concrete source
  const concrete: RefreshSource<Params, Quote> = erased
  void concrete
}
// @ts-expect-error load DTO must match the declared result
defineRefresh<Params, Quote>({ async load() { return { price: 'bad' } } })
void contract
