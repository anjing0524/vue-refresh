import { createApp, defineComponent, h, KeepAlive, onMounted, ref, watch } from 'vue'
import { createPinia } from 'pinia'
import type { Component } from 'vue'
import type { RefreshHandle } from '../src/public-types'
import { createRefreshManager, currentCore, useRefresh } from '../src/vue'
import type { RefreshCore, RefreshHttp } from '../src/core'
import { snapshot } from '../scripts/observe'
interface QuoteParams { account: string; symbol: string }
interface Quote { quote: { price: number; requestId: number } }
import { demoHttp, log } from './sources'
import type { CallLog } from './sources'
import { QueryListPage } from './pages/query-list'
import { QuotePanelPage } from './pages/quote-panel'
import { B09View, SharedPairPage } from './pages/shared-pair'
import './style.css'

const params = new URLSearchParams(location.search)

/** 交付面里失败那一项的只读投影（`cause` 原样带出，观测面不解释它）。 */
/** 集成验证台的只读观测面；只给测试用，不是 src/package API。 */
export interface HarnessSnapshot {
  calls: Array<{ id: number; aborted: boolean; finished: boolean }>
  events: string[]
  /**
   * 每页数据的投影：**没有画面**（还没声明身份／已释放）时是 `null`；
   * 画面存在但从未成功过时是 `data: null, updatedAt: null`。失败不在这份投影里，它来自 `task.failure`（ADR-77）。
   */
  pages: Record<string, {
    readonly args: QuoteParams
    readonly data: Quote | null
    readonly updatedAt: number | null
    readonly error: unknown
    readonly failedAt: number | null
    readonly manual: boolean
  } | null>
  /** 结果表只读投影：`data` 为最后一次成功（从未成功过为 null），`failedAt` 为最近一次失败的时刻。 */
  entries: Record<string, { data: Quote | null; error: unknown; failedAt: number | null }>
  running: number
  queued: number
  resources: number
}
export interface HarnessBridge {
  snapshot(): HarnessSnapshot
  refresh(name: string, symbol: string): void
  nestedOuter(shown: boolean): void
  visibility(hidden: boolean): void
  enable(name: string, enabled: boolean): void
  resolve(id: number, price: number): void
  mutatePage(name: string, price: number): void
  unmount(): void
}

/** 外壳的只读观测面；同样只给示例与测试用。 */
export interface ShellBridge {
  inspect(): {
    resources: number; declarers: number; entries: number
    running: number; queued: number
  }
  log(): { calls: CallLog[]; events: string[] }
}

/**
 * 集成验证台。
 *
 * `tests/browser.html` 与 Playwright 的八条场景共用这一个视图，代码保持原样：它带
 * `?mode=controlled` 的手动结算与只读测试桥，与三条代表页面不是同一类东西，因此不合并；
 * 它的请求函数也不能复用 `sources.ts` 的 `runQuote`——手动结算只在这里需要。
 */
function mountHarness(): void {
  const controlled = params.get('mode') === 'controlled'
  const every = ref(Number(params.get('every') ?? (controlled ? 60_000 : params.has('test') ? 120 : 2_000)))
  const timeout = Number(params.get('timeout') ?? 10_000)
  const calls: Array<{ id: number; signal: AbortSignal; finished: boolean; resolve: (value: Quote) => void }> = []
  const events: string[] = []
  const readQuote = async (args: QuoteParams, { signal }: { signal: AbortSignal }): Promise<Quote> => {
    const id = calls.length + 1
    let resolve!: (value: Quote) => void
    const deferred = controlled ? new Promise<Quote>(yes => { resolve = yes }) : null
    const call = { id, signal, finished: false, resolve: (value: Quote) => resolve(value) }
    calls.push(call)
    signal.addEventListener('abort', () => events.push(`请求${id}：收到取消信号`), { once: true })
    events.push(`请求${id}：开始`)
    try {
      if (deferred) return await deferred
      // Deadline includes response body consumption; no early Promise.race.
      const response = await fetch('/api/quote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data: unknown = await response.json()
      // The HTTP boundary owns the business response contract.
      if (!data || typeof data !== 'object' || !('quote' in data)
        || !data.quote || typeof data.quote !== 'object'
        || !('price' in data.quote) || typeof data.quote.price !== 'number'
        || !Number.isFinite(data.quote.price)
        || !('requestId' in data.quote) || typeof data.quote.requestId !== 'number') {
        throw new TypeError('Invalid quote response')
      }
      return { quote: { price: data.quote.price, requestId: data.quote.requestId } }
    } finally {
      call.finished = true
      events.push(`请求${id}：执行结束`)
    }
  }
  // 参数准入由调用方在 `submit` 之前自己判（框架不再跑任何调用方回调，ADR-74）。
  const source = '/api/quote'
  // 传输：框架只要求一个 post；controlled 模式的手动结算就在这个函数里。
  const http: RefreshHttp = {
    post: async (_url, body, { signal }) => ({ data: await readQuote(body as QuoteParams, { signal }) }),
  }
  // 页面侧事实：上一次手刷拿到的结果时间。框架不再交付「这次是谁触发的」。
  const manualAt: Record<string, number> = {}

  let core: RefreshCore
  const components = new Map<string, { task: RefreshHandle<QuoteParams, Quote>; enabled: ReturnType<typeof ref<boolean>> }>()
  const Widget = defineComponent({
    props: { label: { type: String, required: true } },
    setup(props) {
      core = currentCore()!
      const enabled = ref(true)
      const draftSymbol = ref('DEMO')
      const task = useRefresh<QuoteParams, Quote>(source, { enabled, every })
      // 失败不再经回调推送：失败出口出现新的失败对象时记一条事件（默认 pre flush，首次不触发）。
      watch(() => task.failure.value, failure => {
        if (failure !== null) events.push('后台请求失败，等待下一周期')
      })
      components.set(props.label, { task, enabled })
      const args: QuoteParams = props.label === '甲'
        ? { account: 'demo', symbol: 'DEMO' } : { symbol: 'DEMO', account: 'demo' }
      onMounted(() => task.submit(args))
      return () => {
        const display = task.display.value
        const data = display?.data ?? null
        return h('section', { class: 'card', 'data-testid': props.label }, [
          h('div', { class: 'card-heading' }, [h('h2', `组件${props.label}`), h('span', enabled.value ? '订阅中' : '已暂停')]),
          h('p', { class: 'price', 'data-testid': `price-${props.label}` }, data?.quote.price.toString() ?? '等待首查'),
          h('p', data ? `来自请求 ${data.quote.requestId}` : '两个组件共用同一来源和参数'),
          h('p', display && display.updatedAt !== null
            ? `展示参数：${display.args.symbol} · ${display.updatedAt >= (manualAt[props.label] ?? Infinity) ? '本页刷新' : '共享刷新'}`
            : ''),
          // updatedAt 是墙钟读数：相对时间按 U16/§2.5 的建议把差值钳制到 0，避免校时回拨显示负数。
          h('p', { 'data-testid': `age-${props.label}` }, display && display.updatedAt !== null
            ? `数据时间：${new Date(display.updatedAt).toLocaleTimeString()} · ${Math.max(0, Math.round((Date.now() - display.updatedAt) / 1000))} 秒前`
            : ''),
          h('label', ['品种 ', h('input', { value: draftSymbol.value, onInput: (event: Event) => { draftSymbol.value = (event.target as HTMLInputElement).value } })]),
          h('button', {
            onClick: () => {
              // 手刷没有回执：页面自己记下点击时刻，交付后比较 `updatedAt` 判断这次结果是不是自己的动作之后产生的。
              manualAt[props.label] = Date.now()
              task.submit({ account: 'demo', symbol: draftSymbol.value })
              task.refresh()
            },
          }, '刷新本页'),
          h('button', { onClick: () => { enabled.value = !enabled.value } }, enabled.value ? '暂停刷新' : '恢复刷新'),
        ])
      }
    },
  })
  /**
   * 祖先 KeepAlive 组合（L07.02）：外层 KeepAlive 切走时，内层 KeepAlive 里的页面
   * 必须收到 deactivated 并退订，画面留在缓存里；切回时按订阅规则恢复。
   */
  // 默认不挂载：只有 L07/A05 场景会打开它，避免给其它场景增加第三个身份与请求。
  const nestedOuterShown = ref(false)
  const NestedWidget = defineComponent({
    name: 'NestedWidget',
    setup() {
      const enabled = ref(true)
      const task = useRefresh<QuoteParams, Quote>(source, { enabled, every })
      watch(() => task.failure.value, failure => {
        if (failure !== null) events.push('嵌套页后台请求失败，等待下一周期')
      })
      components.set('嵌套', { task, enabled })
      onMounted(() => task.submit({ account: 'demo', symbol: 'NESTED' }))
      return () => h('section', { class: 'card', 'data-testid': 'nested' }, [
        h('div', { class: 'card-heading' }, [h('h2', '嵌套页'), h('span', enabled.value ? '订阅中' : '已暂停')]),
        h('p', { class: 'price', 'data-testid': 'price-嵌套' }, task.display.value?.data?.quote.price.toString() ?? '等待首查'),
      ])
    },
  })
  const OuterKeepAlive = defineComponent({
    name: 'OuterKeepAlive',
    setup() {
      return () => h(KeepAlive, null, { default: () => h(NestedWidget) })
    },
  })
  const app = createApp({
    render: () => h('main', [
      h('p', { class: 'eyebrow' }, '真实 Vue · HTTP'),
      h('h1', '两个组件，一份共享刷新'),
      h('p', { class: 'intro' }, '暂停一页，另一页继续；全部暂停后取消请求，恢复时重新获取。暂停页面保留自己的画面。'),
      h('div', { class: 'cards' }, [h(Widget, { label: '甲' }), h(Widget, { label: '乙' })]),
      // 双层 KeepAlive：外层切走会让内层页面收到祖先失活。
      h(KeepAlive, null, { default: () => nestedOuterShown.value ? h(OuterKeepAlive) : null }),
      h('p', { class: 'note' }, '固定业务参数接口 · 共享刷新与显式刷新 · 验证范围见运行记录。'),
    ]),
  })
  const pinia = createPinia()
  const refresh = createRefreshManager({ maxConcurrent: params.get('slots') === '1' ? 1 : 2, axios: http, pinia })
  app.use(pinia)
  app.use(refresh)
  if (import.meta.hot) import.meta.hot.dispose(() => refresh.dispose())
  app.mount('#app')

  // Example-only test bridge, never a src/package API or production diagnostic field.
  const bridge: HarnessBridge = {
    snapshot() {
      // 只读观测面：示例面板与测试用同一个投影，不直接读核心的可变字段。
      const view = snapshot(core!)
      return {
        calls: calls.map(c => ({ id: c.id, aborted: c.signal.aborted, finished: c.finished })),
        events: [...events],
        pages: Object.fromEntries([...components].map(([name, c]) => {
          const display = c.task.display.value
          return [name, display === null ? null : {
            args: structuredClone(display.args),
            // `data` 可以为 null（首查就失败）；`updatedAt` 与它同生共死。
            data: display.data === null ? null : structuredClone(display.data),
            updatedAt: display.updatedAt,
            // 失败与数据是两个出口：这里合成一份投影，只为测试读起来方便。
            error: c.task.failure.value?.error,
            failedAt: c.task.failure.value?.failedAt ?? null,
            manual: display.updatedAt !== null && display.updatedAt >= (manualAt[name] ?? Infinity),
          }]
        })),
        entries: Object.fromEntries(view.results
          .map(row => [row.key, {
            data: row.cell.updatedAt === null ? null : row.cell.data as Quote,
            error: row.cell.error,
            failedAt: row.cell.failedAt,
          }])),
        running: view.running.length, queued: view.queued.length,
        resources: view.resources.length,
      }
    },
    refresh(name: string, symbol: string) {
      const page = components.get(name)!
      // 主动刷新：先声明身份，再用与自动刷新同一条路径取一次；没有回执，因此记下点击时刻。
      manualAt[name] = Date.now()
      page.task.submit({ account: 'demo', symbol })
      page.task.refresh()
    },
    enable(name: string, enabled: boolean) { components.get(name)!.enabled.value = enabled },
    resolve(id: number, price: number) { if (controlled) calls[id - 1]!.resolve({ quote: { price, requestId: id } }) },
    mutatePage(name: string, price: number) {
      // Deliberately bypass readonly only to verify runtime ownership isolation.
      const data = components.get(name)!.task.display.value?.data
      if (!data) return
      ;(data as Quote).quote.price = price
    },
    nestedOuter(shown: boolean) { nestedOuterShown.value = shown },
    // 受控可见性：真实浏览器里覆写 document.hidden 并派发真正的 visibilitychange 事件，
    // 走的是 vue.ts 安装时注册的那条监听——适配层因此重报每页快照，核心不持有可见性。
    visibility(hidden: boolean) {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
      document.dispatchEvent(new Event('visibilitychange'))
    },
    unmount() { app.unmount() },
  }
  window.experiment = bridge
}

const VIEWS: Array<{ id: string; label: string; component: Component }> = [
  { id: 'query-list', label: '查询列表', component: QueryListPage },
  { id: 'quote-panel', label: '行情面板', component: QuotePanelPage },
  { id: 'shared-pair', label: '双组件共享', component: SharedPairPage },
  { id: 'b09', label: 'B09 组合', component: B09View },
]

/**
 * 三条代表页面与 B09 组合：只挂载当前视图，切走即整体释放，
 * 因此每个视图的共享事实只由它自己的组件决定。
 */
function mountShell(): void {
  const pinia = createPinia()
  const refresh = createRefreshManager({ maxConcurrent: params.get('slots') === '1' ? 1 : 2, axios: demoHttp, pinia })
  const active = ref(params.get('page') ?? VIEWS[0]!.id)
  let core: RefreshCore | null = null
  const current = (): { id: string; label: string; component: Component } =>
    VIEWS.find(view => view.id === active.value) ?? VIEWS[0]!

  const Shell = defineComponent({
    setup() {
      core = currentCore()!
      return () => h('main', [
        h('p', { class: 'eyebrow' }, '真实 Vue · HTTP · 三个代表页面'),
        h('h1', '统一刷新管理：代表页面'),
        h('nav', { class: 'tabs' }, VIEWS.map(view => h('button', {
          'data-testid': `tab-${view.id}`,
          class: view.id === active.value ? 'tab active' : 'tab',
          onClick: () => { active.value = view.id },
        }, view.label))),
        h('p', { class: 'note' }, '页面只表达刷新需求：身份、共享、调度、取消与有效结果交付由框架负责。'),
        h('section', { class: 'view' }, [h(current().component, { key: current().id })]),
      ])
    },
  })
  const app = createApp(Shell)
  app.use(pinia)
  app.use(refresh)
  if (import.meta.hot) import.meta.hot.dispose(() => refresh.dispose())
  app.mount('#app')

  window.pages = {
    inspect() {
      const view = snapshot(core!)
      return {
        resources: view.resources.length,
        // 声明者数＝各实例声明者之和（观测面不再单列一个派生字段）。
        declarers: view.resources.flatMap(resource => [...resource.declarers]).length,
        entries: view.results.length,
        running: view.running.length, queued: view.queued.length,
      }
    },
    log: () => ({ calls: log.calls.map(call => ({ ...call })), events: [...log.events] }),
  }
}

declare global {
  interface Window {
    experiment: HarnessBridge
    pages: ShellBridge
  }
}

if (params.has('test') || params.get('mode') === 'controlled') mountHarness()
else mountShell()
