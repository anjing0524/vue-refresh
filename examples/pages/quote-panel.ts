/**
 * 代表页面 2 · 行情面板。
 *
 * 展示：无查询按钮、一次提交已准备参数对象、响应式频率、显示数据多旧、
 * 后台首查失败继续、失活冻结（KeepAlive 切走切回）。
 * 面板没有启停入口：开启意愿对组件是常量，框架从不改写它。
 */
import { KeepAlive, computed, defineComponent, h, onMounted, ref, watch } from 'vue'
import { useRefresh } from '../../src/vue'
import { ageLine, quoteSource } from '../sources'
import type { QuoteParams } from '../sources'

const INTERVALS = [1_000, 2_000, 5_000]
const SYMBOLS = ['DEMO', 'DEMO2', 'OTHER']

const QuoteCard = defineComponent({
  name: 'QuoteCard',
  props: { symbol: { type: String, required: true }, every: { type: Number, required: true } },
  emits: { failure: () => true },
  setup(props, { emit }) {
    // 一次准备、一次提交：参数对象只在挂载时构造，不在渲染里重建。
    let submits = 0
    const failures = ref(0)
    const task = useRefresh(quoteSource, {
      enabled: ref(true),
      // 频率是响应式输入：改动它就走配置变化路径，由框架替换当前任务。
      every: computed(() => props.every),
      onError: error => {
        if (error.origin !== 'request') return
        failures.value += 1
        emit('failure')
      },
    })
    const prepared = (symbol: string): QuoteParams => ({ account: 'demo', symbol })
    onMounted(() => { submits += 1; task.submit(prepared(props.symbol)) })
    watch(() => props.symbol, symbol => { submits += 1; task.submit(prepared(symbol)) })

    return () => {
      const display = task.display.value
      return h('section', { class: 'card', 'data-testid': 'qp-card' }, [
        h('h3', `行情 · ${props.symbol}`),
        h('p', { class: 'price', 'data-testid': 'qp-price' }, display ? display.data.quote.price.toFixed(2) : '等待首查'),
        h('p', { 'data-testid': 'qp-request' }, display ? `来自请求 ${display.data.quote.requestId}` : ''),
        h('p', { 'data-testid': 'qp-age' }, display ? `数据时间：${ageLine(display.updatedAt)}` : ''),
        h('p', { 'data-testid': 'qp-submitted' }, display
          ? `已提交参数：${display.args.account} / ${display.args.symbol}`
          : '已提交参数：尚未交付'),
        h('p', { 'data-testid': 'qp-submits' }, `提交次数：${submits}`),
        h('p', { 'data-testid': 'qp-failures' }, `后台失败次数：${failures.value}`),
        h('p', { 'data-testid': 'qp-note' }, failures.value > 0 ? '后台失败不关闭需求：保留开启意愿，下个周期继续' : ''),
      ])
    }
  },
})

export const QuotePanelPage = defineComponent({
  name: 'QuotePanelPage',
  setup() {
    const symbol = ref('DEMO')
    const every = ref(2_000)
    const mounted = ref(true)
    const failures = ref(0)
    const visits = ref(0)
    return () => h('section', { class: 'page', 'data-testid': 'page-quote-panel' }, [
      h('h2', '行情面板'),
      h('p', { class: 'intro' }, '面板没有查询按钮：挂载时提交一次已准备的参数对象。频率是响应式输入，切走（KeepAlive 失活）即冻结，切回恢复。'),
      h('div', { class: 'actions' }, [
        h('label', { class: 'field' }, ['品种', h('select', {
          'data-testid': 'qp-symbol', value: symbol.value,
          onChange: (event: Event) => { symbol.value = (event.target as HTMLSelectElement).value },
        }, SYMBOLS.map(value => h('option', { value }, value)))]),
        h('label', { class: 'field' }, ['刷新频率', h('select', {
          'data-testid': 'qp-every', value: String(every.value),
          onChange: (event: Event) => { every.value = Number((event.target as HTMLSelectElement).value) },
        }, INTERVALS.map(ms => h('option', { value: String(ms) }, `${ms / 1000} 秒`)))]),
        h('button', {
          'data-testid': 'qp-toggle-live',
          onClick: () => { mounted.value = !mounted.value; if (mounted.value) visits.value += 1 },
        }, mounted.value ? '切走（失活冻结）' : '切回（恢复刷新）'),
      ]),
      h('p', { 'data-testid': 'qp-state' }, mounted.value ? '面板已激活' : '面板已失活（冻结）'),
      h('p', { 'data-testid': 'qp-visits' }, `切回次数：${visits.value}`),
      h('p', { 'data-testid': 'qp-panel-failures' }, `后台失败次数：${failures.value}`),
      h(KeepAlive, null, {
        default: () => mounted.value
          ? h(QuoteCard, {
            key: 'quote', symbol: symbol.value, every: every.value,
            onFailure: () => { failures.value += 1 },
          })
          : null,
      }),
    ])
  },
})
