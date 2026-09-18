#!/usr/bin/env node
// 阶段 14 基线测量（G04 的回归证据）：在已确认规模（约 20+ 订阅、在途请求很少）下测量
// 框架自身的可测代理量——共享收敛、真实在途峰值、事件循环延迟、释放后残留。
//
// 边界，先说清楚：
// - 只走公开入口（`createRefreshManager` + `useRefresh`）与真实 Vue；传输只让出一个
//   微任务，因此**不含浏览器渲染、真实网络与真实业务数据**。真实流量口径由接入方实测（§5 G04）。
// - 堆增量未强制 GC，只是粗代理；事件循环延迟由 `monitorEventLoopDelay` 给出。
// - **不设性能阈值**。脚本只在契约被破坏时以非零码退出：真实在途峰值超过 `maxConcurrent`，
//   或释放后仍有 Resource / 句柄 / 排队任务 / 分区残留。数字本身只作为回归对照。
//
// 用法：node scripts/benchmark.mjs [--duration 2000] [--subscriptions 24] [--identities 8]
//                                [--every 25] [--runs 3]
import { monitorEventLoopDelay } from 'node:perf_hooks'

// 最小浏览器环境：install 会注册可见性监听（本库只服务 SPA）。
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} }
import { createRenderer, defineComponent, h, onMounted, ref, watch } from 'vue'
import { createPinia } from 'pinia'
import { createRefreshManager, currentCore } from '../src/vue.ts'
import { useRefresh } from '../src/vue.ts'
import { snapshot } from '../tests/support/observe.ts'

const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? fallback : Number(process.argv[index + 1])
}
const duration = option('duration', 2_000)
const subscriptionCount = option('subscriptions', 24)
const identityCount = option('identities', 8)
const every = option('every', 25)
const runs = option('runs', 3)
const maxConcurrent = 4

// 最小自定义渲染器：只驱动 Vue 生命周期，不渲染 DOM。
// 与 tests/vue.test.ts 的同名工具故意不共享（两个套件的替身各自服务不同目的，见 tests/fixture.ts 的说明）。
const node = (text = '') => ({ parent: null, children: [], text })
const renderer = createRenderer({
  createElement: node, createText: node, createComment: node,
  setText(el, text) { el.text = text }, setElementText(el, text) { el.text = text },
  parentNode: el => el.parent,
  nextSibling: el => el.parent?.children[el.parent.children.indexOf(el) + 1] ?? null,
  patchProp() {},
  insert(el, parent, anchor = null) {
    if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1)
    const index = anchor ? parent.children.indexOf(anchor) : -1
    parent.children.splice(index < 0 ? parent.children.length : index, 0, el); el.parent = parent
  },
  remove(el) { if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1); el.parent = null },
})

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 一次完整测量：挂载 → 运行 duration → 卸载并销毁 → 读残留。 */
async function measure() {
  let core = null
  let loads = 0
  let active = 0
  let peakInFlight = 0
  let peakRunning = 0
  let failures = 0
  // 在途很少：取数只让出一个微任务，因此 active 反映框架真实同时在途的请求数，
  // 而并发上限只能由框架的槽位决定。
  const http = {
    post: async () => {
      loads += 1
      active += 1
      peakInFlight = Math.max(peakInFlight, active)
      // 交叉核对：在真实请求的入口读框架自己的槽位投影。
      peakRunning = Math.max(peakRunning, snapshot(core).running.length)
      try {
        await Promise.resolve()
        return { data: { price: loads } }
      } finally {
        active -= 1
      }
    },
  }

  const Card = defineComponent({
    props: { identity: { type: Number, required: true } },
    setup(props) {
      core = currentCore()
      // 本库只服务 SPA：Node 里跑基准要先给出最小浏览器环境，再显式声明可见，
      // 与 tests/vue.test.ts 的做法一致（自定义渲染器不冒充浏览器可见性测试）。
      core.setVisible(true)
      const task = useRefresh('/api/benchmark', { enabled: ref(true), every: ref(every) })
      // 失败不再回调推送：交付面出现新的失败时刻时计一次（这是原输出字段 `failures` 的来源）。
      watch(() => task.display.value?.failedAt, failedAt => { if (failedAt !== null) failures += 1 })
      onMounted(() => task.submit({ symbol: `S${props.identity}` }))
      return () => h('span', String(task.display.value?.data?.price ?? ''))
    },
  })
  const cards = Array.from({ length: subscriptionCount }, (_, index) => index % identityCount)
  const app = renderer.createApp({
    render: () => h('div', cards.map((identity, index) => h(Card, { key: index, identity }))),
  })
  const pinia = createPinia()
  const manager = createRefreshManager({ maxConcurrent, axios: http, pinia })
  app.use(pinia)
  app.use(manager)

  const heapBefore = process.memoryUsage().heapUsed
  const started = performance.now()
  app.mount(node())
  await sleep(duration)
  const elapsed = performance.now() - started
  const view = snapshot(core)
  const declarers = view.resources.reduce((total, resource) => total + resource.declarers.size, 0)
  const observed = { resources: view.resources.length, declarers, running: view.running.length }

  app.unmount()
  manager.dispose()
  const after = snapshot(core)
  const residue = {
    resources: after.resources.length,
    declarers: after.resources.reduce((total, resource) => total + resource.declarers.size, 0),
    queued: after.queued.length,
    running: after.running.length, entries: after.results.length,
  }
  const heapAfter = process.memoryUsage().heapUsed
  const expectedCycles = Math.max(1, Math.round(elapsed / every))
  return {
    elapsed: Math.round(elapsed), loads, failures, peakInFlight, peakRunning, observed, residue,
    convergence: Number((loads / (identityCount * expectedCycles)).toFixed(2)),
    perSubscriberCounterfactual: subscriptionCount * expectedCycles,
    heapDeltaKb: Math.round((heapAfter - heapBefore) / 1024),
  }
}

const histogram = monitorEventLoopDelay({ resolution: 1 })
histogram.enable()
await measure() // 预热，不计入
const results = []
for (let index = 0; index < runs; index += 1) results.push(await measure())
histogram.disable()

const median = key => {
  const values = results.map(result => result[key]).sort((left, right) => left - right)
  return values[Math.floor(values.length / 2)]
}
const last = results[results.length - 1]
console.log(`[bench] 规模：${subscriptionCount} 订阅 / ${identityCount} 身份 / every=${every}ms / maxConcurrent=${maxConcurrent} / 运行 ${duration}ms × ${runs}`)
for (const [index, result] of results.entries()) {
  console.log(`[bench] 第 ${index + 1} 次：实际 ${result.elapsed}ms 内取数 ${result.loads} 次`
    + `（收敛比 ${result.convergence}；按订阅计的反事实 ${result.perSubscriberCounterfactual} 次）`
    + ` · 在途峰值 ${result.peakInFlight}（框架 running 投影峰值 ${result.peakRunning}）/ 上限 ${maxConcurrent}`
    + ` · 结束瞬间 Resource ${result.observed.resources} 声明 ${result.observed.declarers}`
    + ` · 后台失败 ${result.failures} · 堆增量 ${result.heapDeltaKb}KB`)
}
console.log(`[bench] 中位：取数 ${median('loads')} 次 · 收敛比 ${median('convergence')}`
  + ` · 在途峰值 ${median('peakInFlight')} · 事件循环延迟 mean ${(histogram.mean / 1e6).toFixed(2)}ms`
  + ` p99 ${(histogram.percentile(99) / 1e6).toFixed(2)}ms max ${(histogram.max / 1e6).toFixed(2)}ms`)
console.log(`[bench] 释放后残留：${JSON.stringify(last.residue)}`)

const broken = results.some(result => result.peakInFlight > maxConcurrent)
  || results.some(result => Object.values(result.residue).some(value => value !== 0))
if (broken) {
  console.error('[bench] 契约被破坏：真实在途超过 maxConcurrent，或释放后仍有残留')
  process.exit(1)
}
