/**
 * 三条代表页面与 B09 组合的外壳：只挂载当前视图，切走即整体释放，
 * 因此每个视图的共享事实只由它自己的组件决定。
 */
import { createApp, defineComponent, h, ref } from 'vue'
import { createPinia } from 'pinia'
import type { Component } from 'vue'
import { createRefreshManager, currentCore } from '../src/vue'
import type { RefreshCore } from '../src/core'
import { snapshot } from '../scripts/observe'
import { demoHttp, log } from './sources'
import type { CallLog } from './sources'
import { QueryListPage } from './pages/query-list'
import { QuotePanelPage } from './pages/quote-panel'
import { B09View, SharedPairPage } from './pages/shared-pair'
import './style.css'

const params = new URLSearchParams(location.search)


/** 外壳的只读观测面；同样只给示例与测试用。 */
export interface ShellBridge {
  inspect(): {
    resources: number; declarers: number; entries: number
    running: number; queued: number
  }
  log(): { calls: CallLog[]; events: string[] }
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
export function mountShell(): void {
  const pinia = createPinia()
  const refresh = createRefreshManager({ maxConcurrent: params.get('slots') === '1' ? 1 : 2, http: demoHttp, pinia })
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
