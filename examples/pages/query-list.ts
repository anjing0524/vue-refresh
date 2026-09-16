/**
 * 代表页面 1 · 查询列表。
 *
 * 展示：完整参数提交、独立启停、分页排序复用已提交参数、失败关闭、暂停仍可单查。
 * 页面只做三件事：维护表单草稿、调用公开入口、渲染本页快照；不碰共享分区、不自建 Timer。
 */
import { defineComponent, h, onMounted, ref, shallowRef } from 'vue'
import { useRefresh } from '../../src/vue'
import { ageLine, listSource } from '../sources'
import type { ListParams, SortField } from '../sources'

const SORTS: readonly SortField[] = ['price', 'change', 'volume']
const SORT_LABEL: Record<SortField, string> = { price: '价格', change: '涨跌幅', volume: '成交量' }

export const QueryListPage = defineComponent({
  name: 'QueryListPage',
  setup() {
    // 表单是草稿：改动它既不产生请求，也不改数据身份。
    const account = ref('demo')
    const market = ref('SH')
    const page = ref(1)
    const sortBy = ref<SortField>('price')
    const enabled = ref(true)
    const note = ref('')
    // 页面自己记录「本次提交了什么」：已提交参数是页面的事实，不依赖是否已经交付。
    // 必须用 shallowRef：ref 会把参数对象包成 Proxy，而框架在提交边界执行结构化克隆。
    const submitted = shallowRef<ListParams | null>(null)

    const draft = (): ListParams => ({
      account: account.value, market: market.value, page: page.value, sortBy: sortBy.value,
    })
    const submit = (): void => {
      const args = draft()
      note.value = ''
      if (task.submit(args).status === 'accepted') submitted.value = args
    }

    const task = useRefresh(listSource, {
      enabled,
      every: 1_500,
      onError: error => {
        // 框架只通知、从不写 enabled；「失败关闭」是页面在 onError 里自己做的决定。
        if (error.origin === 'background') {
          enabled.value = false
          note.value = '后台请求失败：页面关闭自动刷新（框架不改写 enabled）'
        } else {
          note.value = `页面查询失败：${error.origin}`
        }
      },
    })

    onMounted(submit)

    const sameAsDraft = (): boolean => {
      const args = submitted.value
      if (!args) return false
      const form = draft()
      return args.account === form.account && args.market === form.market
        && args.page === form.page && args.sortBy === form.sortBy
    }
    const once = (): void => {
      const args = submitted.value ?? draft()
      note.value = ''
      submitted.value = args
      // 暂停后单查：声明该身份并显式刷新一次；刷新不恢复自动轮询。
      task.submit(args)
      void task.refresh()
    }
    const field = (label: string, input: () => unknown) =>
      h('label', { class: 'field' }, [label, input() as never])

    return () => {
      const display = task.display.value
      const rows = display?.data.rows ?? []
      return h('section', { class: 'page', 'data-testid': 'page-query-list' }, [
        h('h2', '查询列表'),
        h('p', { class: 'intro' }, '改动表单不会发请求；点「提交查询」才把四个字段一起作为新身份提交。暂停后画面保留，仍可只查一次。'),
        h('div', { class: 'form' }, [
          field('账号', () => h('input', {
            'data-testid': 'ql-account', value: account.value,
            onInput: (event: Event) => { account.value = (event.target as HTMLInputElement).value },
          })),
          field('市场', () => h('select', {
            'data-testid': 'ql-market', value: market.value,
            onChange: (event: Event) => { market.value = (event.target as HTMLSelectElement).value },
          }, ['SH', 'SZ', 'HK'].map(code => h('option', { value: code }, code)))),
          field('页码', () => h('input', {
            'data-testid': 'ql-page', type: 'number', min: 1, value: page.value,
            onInput: (event: Event) => { page.value = Number((event.target as HTMLInputElement).value) },
          })),
          field('排序', () => h('select', {
            'data-testid': 'ql-sort', value: sortBy.value,
            onChange: (event: Event) => { sortBy.value = (event.target as HTMLSelectElement).value as SortField },
          }, SORTS.map(value => h('option', { value }, SORT_LABEL[value])))),
        ]),
        h('div', { class: 'actions' }, [
          h('button', { 'data-testid': 'ql-submit', onClick: submit }, '提交查询'),
          h('button', {
            'data-testid': 'ql-toggle',
            onClick: () => { note.value = ''; enabled.value = !enabled.value },
          }, enabled.value ? '暂停自动刷新' : '恢复自动刷新'),
          h('button', { 'data-testid': 'ql-once', onClick: once }, '只查一次'),
        ]),
        h('p', { 'data-testid': 'ql-status' }, enabled.value ? '自动刷新中' : '已暂停'),
        h('p', { 'data-testid': 'ql-diff' }, sameAsDraft() ? '表单与已提交参数一致' : '表单有未提交修改'),
        h('p', { 'data-testid': 'ql-submitted' }, submitted.value
          ? `已提交参数：${submitted.value.account} / ${submitted.value.market} / 第 ${submitted.value.page} 页 / 按${SORT_LABEL[submitted.value.sortBy]}`
          : '尚未提交'),
        h('p', { 'data-testid': 'ql-origin' }, display
          ? `本次来源：${display.origin === 'refresh' ? '本页刷新' : '共享刷新'} · 请求号 ${display.data.requestId}`
          : ''),
        h('p', { 'data-testid': 'ql-age' }, display ? ageLine(display.updatedAt) : ''),
        h('p', { 'data-testid': 'ql-note' }, note.value),
        h('table', { class: 'rows' }, [
          h('thead', [h('tr', ['代码', '价格', '涨跌幅', '成交量'].map(head => h('th', head)))]),
          h('tbody', rows.map(row => h('tr', { 'data-testid': `ql-row-${row.symbol}` }, [
            h('td', row.symbol),
            h('td', { 'data-testid': `ql-price-${row.symbol}` }, row.price.toFixed(2)),
            h('td', row.change.toFixed(2)),
            h('td', row.volume.toString()),
          ]))),
        ]),
      ])
    }
  },
})
