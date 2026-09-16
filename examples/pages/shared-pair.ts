/**
 * 代表页面 3 · 双组件共享（附「无启停按钮」的 B09 组合，单独成视图）。
 *
 * 展示：1s/5s 同参共享、切换品种、单页暂停、全部退订、重新进入、Store 快照隔离。
 * 页面不判断共享：两份快照显示同一个请求号，就是框架把一次 load 交付给了两个订阅。
 */
import { defineComponent, h, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import type { Ref } from 'vue'
import { useRefresh } from '../../src/vue'
import { ageLine, quoteSource, readShared } from '../sources'
import type { QuoteParams, QuoteResult } from '../sources'
import type { RefreshHandle } from '../../src/public-types'

interface Entry { task: RefreshHandle<QuoteParams, QuoteResult>; enabled: Ref<boolean> }

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
    const enabled = ref(true)
    const failures = ref(0)
    const task = useRefresh(quoteSource, {
      enabled,
      every: props.every,
      onError: error => { if (error.origin === 'background') failures.value += 1 },
    })
    const params = (symbol: string): QuoteParams => ({ account: 'demo', symbol })
    onMounted(() => task.submit(params(props.symbol)))
    watch(() => props.symbol, symbol => task.submit(params(symbol)))
    emit('ready', props.label, { task, enabled })
    onUnmounted(() => emit('gone', props.label))

    return () => {
      const display = task.display.value
      return h('section', { class: 'card', 'data-testid': `sp-card-${props.label}` }, [
        h('h3', [props.label, h('span', { class: 'tag' }, `每 ${props.every / 1000} 秒`)]),
        h('p', { class: 'price', 'data-testid': `sp-price-${props.label}` }, display ? display.data.quote.price.toFixed(2) : '等待首查'),
        h('p', { 'data-testid': `sp-request-${props.label}` }, display
          ? `来自请求 ${display.data.quote.requestId} · ${display.args.symbol}`
          : '尚未交付'),
        h('p', { 'data-testid': `sp-age-${props.label}` }, display ? ageLine(display.updatedAt) : ''),
        h('p', { 'data-testid': `sp-failures-${props.label}` }, `后台失败：${failures.value} 次`),
        h('button', {
          'data-testid': `sp-toggle-${props.label}`,
          onClick: () => { enabled.value = !enabled.value },
        }, enabled.value ? '暂停本页' : '恢复本页'),
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
    const snapshot = ref('尚未读取')
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
      const display = entries.value[label]?.task.display.value
      return display ? display.data.quote.price.toFixed(2) : '—'
    }
    const state = (): string => `甲：${showA.value ? '订阅中' : '已退订'} ｜ 乙：${showB.value ? '订阅中' : '已退订'}`

    return () => h('section', { class: 'page', 'data-testid': 'page-shared-pair' }, [
      h('h2', '双组件共享'),
      h('p', { class: 'intro' }, '两个组件同参、频率不同（1 秒 / 5 秒）；共享时取最小间隔，一次 load 交付给两个订阅。暂停一页不影响另一页；全部退订后实例与分区一起消失。'),
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
          'data-testid': 'sp-read-snapshot',
          onClick: () => {
            const value = readShared(quoteSource, { account: 'demo', symbol: symbol.value })
            snapshot.value = value ? value.quote.price.toFixed(2) : '无分区'
          },
        }, '读共享快照'),
        h('button', {
          'data-testid': 'sp-mutate-a',
          onClick: () => {
            const display = entries.value['甲']?.task.display.value
            if (!display) return
            // 故意绕过 readonly，验证运行期所有权：页面副本与共享分区之间没有别名。
            ;(display.data as unknown as QuoteResult).quote.price = 999
            revision.value += 1
          },
        }, '篡改甲的画面副本'),
      ]),
      h('p', { 'data-testid': 'sp-pair-state' }, state()),
      h('p', { 'data-testid': 'sp-snapshot' }, `共享快照（readSnapshot）：${snapshot.value}`),
      h('p', { 'data-testid': 'sp-copies' }, `画面副本对照（第 ${revision.value} 次篡改后）：甲 ${copyPrice('甲')} ｜ 乙 ${copyPrice('乙')}`),
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
    const task = useRefresh(quoteSource, {
      enabled,
      every: 5_000,
      onError: error => {
        if (error.origin !== 'background') return
        failures.value += 1
        enabled.value = false // 页面自己的策略：前次失败后先关闭意愿。
      },
    })
    onMounted(() => task.submit({ account: 'demo', symbol: 'B09' }))

    const refreshAndResume = (): void => {
      // 在同一个同步块里开启意愿并声明新身份：框架必须先退出旧订阅、按新身份请求，
      // 不能先按旧参数发后台请求（旧契约由 runner 的同步前缀保证，现在由声明顺序保证）。
      enabled.value = true
      task.submit({ account: 'demo', symbol: 'B09-NEW' })
      void task.refresh()
    }
    return () => {
      const display = task.display.value
      return h('section', { class: 'page', 'data-testid': 'page-b09' }, [
        h('h2', '无启停按钮的刷新组合（B09）'),
        h('p', { class: 'intro' }, '本视图没有任何启停按钮。挂载时按 B09 参数提交并失败一次，页面在 onError 里关闭意愿；点下面的按钮开启意愿、声明新身份并刷新一次。'),
        h('p', { 'data-testid': 'b09-failures' }, `前次后台失败：${failures.value} 次`),
        h('p', { 'data-testid': 'b09-state' }, enabled.value ? '开启意愿：真' : '开启意愿：假（页面已关闭）'),
        h('p', { class: 'price', 'data-testid': 'b09-price' }, display ? display.data.quote.price.toFixed(2) : '等待首查'),
        h('p', { 'data-testid': 'b09-request' }, display
          ? `来自请求 ${display.data.quote.requestId} · ${display.args.symbol} · 来源 ${display.origin}`
          : '尚未交付'),
        h('button', { 'data-testid': 'b09-refresh', onClick: refreshAndResume }, '刷新并在页面内开启订阅'),
      ])
    }
  },
})
