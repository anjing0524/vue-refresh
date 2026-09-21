/**
 * 代表页面 3 · 双组件共享（附「无启停按钮」的 B09 组合，单独成视图）。
 *
 * 展示：1s/5s 同参共享、切换品种、单页暂停（只停驱动、画面仍读共享结果）、全部退订、重新进入、结果共享。
 * 「暂停本页」演示改 "enabled.value"：两项配置都是 Ref，改值即改配置。
 * 页面不判断共享：两份画面显示同一个请求号，就是两个订阅读到了同一份共享结果。
 */
import { computed, defineComponent, h, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useRefresh } from '../../src/vue'
import { ageLine, QUOTE_URL } from '../sources'
import type { QuoteParams, QuoteResult } from '../sources'
import type { RefreshHandle, RefreshOptions } from '../../src/public-types'

interface Entry { task: RefreshHandle<QuoteParams, QuoteResult> }

const PairCard = defineComponent({
  name: 'PairCard',
  props: {
    label: { type: String, required: true },
    symbol: { type: String, required: true },
    every: { type: Number, required: true },
  },
  emits: {
    ready: (label: string, entry: Entry) => Boolean(label) && Boolean(entry),
    gone: (label: string) => Boolean(label),
  },
  setup(props, { emit }) {
    const failures = ref(0)
    // 两项配置都是 Ref：改 .value 就是改配置。
    const options: RefreshOptions = {
      enabled: ref(true),
      every: computed(() => props.every),
    }
    const task = useRefresh<QuoteParams, QuoteResult>(QUOTE_URL, options)
    // 失败不再由框架推送：出口上出现新的一笔失败时计一次（默认 pre flush，首次不触发）。
    watch(() => task.display.value?.failed, failed => { if (failed === true) failures.value += 1 })
    const params = (symbol: string): QuoteParams => ({ account: 'demo', symbol })
    onMounted(() => task.submit(params(props.symbol)))
    watch(() => props.symbol, symbol => task.submit(params(symbol)))
    emit('ready', props.label, { task })
    onUnmounted(() => emit('gone', props.label))

    return () => {
      // 首查就失败时 display 不是 null，而是 `data: null`：空态按 data／updatedAt 判，失败在同一个出口上。
      const data = task.display.value?.data ?? null
      const args = task.display.value?.args ?? null
      const updatedAt = task.display.value?.updatedAt ?? null
      return h('section', { class: 'card', 'data-testid': `sp-card-${props.label}` }, [
        h('h3', [props.label, h('span', { class: 'tag' }, `每 ${props.every / 1000} 秒`)]),
        h('p', { class: 'price', 'data-testid': `sp-price-${props.label}` }, data ? data.quote.price.toFixed(2) : '等待首查'),
        h('p', { 'data-testid': `sp-request-${props.label}` }, data !== null && args !== null
          ? `来自请求 ${data.quote.requestId} · ${args.symbol}`
          : '尚未交付'),
        h('p', { 'data-testid': `sp-age-${props.label}` }, updatedAt !== null ? ageLine(updatedAt) : ''),
        h('p', { 'data-testid': `sp-failures-${props.label}` }, `后台失败：${failures.value} 次`),
        h('button', {
          'data-testid': `sp-toggle-${props.label}`,
          onClick: () => { options.enabled.value = !options.enabled.value },
        }, options.enabled.value ? '暂停本页' : '恢复本页'),
        // 显式刷新一次：暂停页也能用（A05），而且这一次不等节流窗口，结果一到就上屏（ADR-63）。
        h('button', {
          'data-testid': `sp-once-${props.label}`,
          onClick: () => { task.refresh() },
        }, '刷新本页一次'),
      ])
    }
  },
})

export const SharedPairPage = defineComponent({
  name: 'SharedPairPage',
  setup() {
    const symbol = ref('DEMO')
    const showA = ref(true)
    const showB = ref(true)
    const revision = ref(0)
    // 句柄注册表用 shallowRef：句柄内部有 ref，不能被深层响应式代理解包。
    const entries = shallowRef<Record<string, Entry>>({})

    const register = (label: string, entry: Entry): void => {
      entries.value = { ...entries.value, [label]: entry }
    }
    const forget = (label: string): void => {
      const next = { ...entries.value }
      delete next[label]
      entries.value = next
    }
    const copyPrice = (label: string): string => {
      const data = entries.value[label]?.task.display.value?.data
      return data ? data.quote.price.toFixed(2) : '—'
    }
    const state = (): string => `甲：${showA.value ? '订阅中' : '已退订'} ｜ 乙：${showB.value ? '订阅中' : '已退订'}`

    return () => h('section', { class: 'page', 'data-testid': 'page-shared-pair' }, [
      h('h2', '双组件共享'),
      h('p', { class: 'intro' }, '两个组件同参、频率不同（1 秒 / 5 秒）；共享时取最小间隔，一次取数的结果写进同一张结果表。暂停只停「由这一页驱动取数」，画面仍然读共享值；全部退订后实例与结果表条目一起消失。'),
      h('div', { class: 'actions' }, [
        h('label', { class: 'field' }, ['品种', h('select', {
          'data-testid': 'sp-symbol', value: symbol.value,
          onChange: (event: Event) => { symbol.value = (event.target as HTMLSelectElement).value },
        }, ['DEMO', 'DEMO2', 'OTHER'].map(value => h('option', { value }, value)))]),
        h('button', { 'data-testid': 'sp-unmount-a', onClick: () => { showA.value = false } }, '卸载甲（乙继续）'),
        h('button', { 'data-testid': 'sp-mount-a', onClick: () => { showA.value = true } }, '重新进入甲'),
        h('button', { 'data-testid': 'sp-unmount-all', onClick: () => { showA.value = false; showB.value = false } }, '全部退订'),
        h('button', {
          'data-testid': 'sp-remount',
          onClick: () => { showA.value = true; showB.value = true },
        }, '重新进入两页'),
        h('button', {
          'data-testid': 'sp-mutate-a',
          onClick: () => {
            const display = entries.value['甲']?.task.display.value
            if (!display?.data) return
            // 故意绕过 readonly，验证运行期所有权：结果是共享对象，改了它同身份的读者一起变（ADR-59）。
            ;(display.data as unknown as QuoteResult).quote.price = 999
            revision.value += 1
          },
        }, '篡改甲的 data（共享对象）'),
      ]),
      h('p', { 'data-testid': 'sp-pair-state' }, state()),
      h('p', { 'data-testid': 'sp-copies' }, `共享结果对照（第 ${revision.value} 次篡改后）：甲 ${copyPrice('甲')} ｜ 乙 ${copyPrice('乙')}`),
      h('div', { class: 'cards' }, [
        showA.value
          ? h(PairCard, { key: '甲', label: '甲', symbol: symbol.value, every: 1_000, onReady: register, onGone: forget })
          : null,
        showB.value
          ? h(PairCard, { key: '乙', label: '乙', symbol: symbol.value, every: 5_000, onReady: register, onGone: forget })
          : null,
      ]),
    ])
  },
})

/** 无启停按钮的刷新组合（B09）：开启意愿只由「前次失败」与「按钮回调」两处代码决定。 */
export const B09View = defineComponent({
  name: 'B09View',
  setup() {
    const enabled = ref(true)
    const failures = ref(0)
    const task = useRefresh<QuoteParams, QuoteResult>(QUOTE_URL, { enabled, every: ref(5_000) })
    // 失败只从出口读到：出现新的一笔失败时，页面自己关闭开启意愿（框架从不写 enabled）。
    watch(() => task.display.value?.failed, failed => {
      if (failed !== true) return
      failures.value += 1
      enabled.value = false // 页面自己的策略：前次失败后先关闭意愿。
    })
    onMounted(() => task.submit({ account: 'demo', symbol: 'B09' }))

    const refreshAndResume = (): void => {
      // 在同一个同步块里开启意愿并声明新身份：框架必须先退出旧订阅、按新身份请求，
      // 不能先按旧参数发后台请求（旧契约由 runner 的同步前缀保证，现在由声明顺序保证）。
      enabled.value = true
      task.submit({ account: 'demo', symbol: 'B09-NEW' })
      task.refresh()
    }
    return () => {
      const data = task.display.value?.data ?? null
      const args = task.display.value?.args ?? null
      return h('section', { class: 'page', 'data-testid': 'page-b09' }, [
        h('h2', '无启停按钮的刷新组合（B09）'),
        h('p', { class: 'intro' }, '本视图没有任何启停按钮。挂载时按 B09 参数提交并失败一次，页面从交付面读到失败后关闭意愿；点下面的按钮开启意愿、声明新身份并刷新一次。'),
        h('p', { 'data-testid': 'b09-failures' }, `前次后台失败：${failures.value} 次`),
        h('p', { 'data-testid': 'b09-state' }, enabled.value ? '开启意愿：真' : '开启意愿：假（页面已关闭）'),
        h('p', { class: 'price', 'data-testid': 'b09-price' }, data ? data.quote.price.toFixed(2) : '等待首查'),
        h('p', { 'data-testid': 'b09-request' }, data !== null && args !== null
          ? `来自请求 ${data.quote.requestId} · ${args.symbol}`
          : '尚未交付'),
        h('button', { 'data-testid': 'b09-refresh', onClick: refreshAndResume }, '刷新并在页面内开启订阅'),
      ])
    }
  },
})
