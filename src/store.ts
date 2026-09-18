import { defineStore } from 'pinia'
import { shallowRef } from 'vue'
import type { ShallowRef } from 'vue'
import type { Entry, ResultRow } from './core.ts'

/**
 * 结果表：每个 (url, key) 一份独立 `shallowRef`。
 *
 * **粒度对齐数据**：写一格只唤醒订阅这一格的 `watcher`（vue.ts 的 `display` 副作用依赖的就是
 * 那一个 ref），其余 watcher 不会被多余唤醒。代价是失去 `results` 单一对象可观测——调试期
 * 用 `list()` 列举，或读 `cells.get(...)`。
 *
 * **整 cell 不删**：实例释放时只把 ref 的值置为 `undefined`，不 `Map.delete`。这是因为
 * `watcher` 的依赖是那个具体的 ref 对象——若 `Map.delete` 后再有同一身份的写入，会建一个新
 * ref，watcher 的依赖对象已死，不会被新 ref 唤醒（display 停摆）。保留 ref 让「再写就原地改
 * 同一个 ref」，依赖关系稳定。代价是 Map 不会缩：曾经存在的每个身份都留一份 ref（典型规模
 * 几十份，每份几十字节，可接受）。
 *
 * **写不复制**：`write` 直接写 cell ref（`shallowRef.value = entry`）；这正是 `shallowRef`
 * 而不是 `ref` 的原因——内层 Entry 是 `core.ts` 里 `structuredClone(response.data)` 出来的
 * 普通对象，保持普通对象身份才能让消费侧 `structuredClone` 不抛错。Entry 本身不可变（写时
 * 整条换），所以读到的 `.data` 是结果表里同一个对象，要改自己复制（ADR-52、ADR-59）。
 *
 * 模块级：一个 Pinia 实例一张表，多个 `createRefreshManager` 共用同一张表也是同一个意思
 * （同一 URL ＋ 同一参数值就是同一份数据）。
 */
export const useRefreshStore = defineStore('vue-refresh', () => {
  const cells = new Map<string, ShallowRef<Entry | undefined>>()
  const keyOf = (url: string, key: string): string => `${url}\0${key}`

  /** 取或建对应 cell ref；首次建时是 `undefined`。 */
  const refOf = (url: string, key: string): ShallowRef<Entry | undefined> => {
    const k = keyOf(url, key)
    let ref = cells.get(k)
    if (!ref) {
      ref = shallowRef<Entry | undefined>(undefined)
      cells.set(k, ref)
    }
    return ref
  }

  const write = (url: string, key: string, entry: Entry): void => {
    refOf(url, key).value = entry
  }

  /** 实例释放时把该格的 entry 清掉，但 cell ref 本身保留——见上文「整 cell 不删」。 */
  const remove = (url: string, key: string): void => {
    const ref = cells.get(keyOf(url, key))
    if (ref) ref.value = undefined
  }

  const read = (url: string, key: string): Entry | undefined => refOf(url, key).value

  /** 只读列举：给 `snapshot()` 这类观测面用，不是包契约。 */
  const list = (): readonly ResultRow[] => {
    const rows: ResultRow[] = []
    for (const [k, ref] of cells) {
      const entry = ref.value
      if (entry === undefined) continue
      const sep = k.indexOf('\0')
      rows.push({ url: k.slice(0, sep), key: k.slice(sep + 1), entry })
    }
    return rows
  }

  return { cells, write, remove, read, list }
})
