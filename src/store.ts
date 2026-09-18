import { defineStore } from 'pinia'
import { shallowRef } from 'vue'
import type { Entry, ResultRow } from './core.ts'

/**
 * 结果表：**结果的唯一真值**，按「URL → 参数键」两级分组。
 *
 * 整条替换：写入时换掉顶层对象与那一级桶，条目本身从不就地改，读者拿到的也永远是普通对象
 * （`shallowRef` 不会把内层变成 Vue 的深代理，而 `structuredClone` 在 Proxy 上会抛）。
 * 生命周期跟着共享实例：内核在实例释放时经 `remove` 删条目（A06「随实例清」），因此这里没有淘汰策略。
 *
 * 定义在**模块级**：一个 Pinia 实例一张表，多个 `createRefreshManager` 共用同一张表也是同一个意思
 * （同一 URL ＋ 同一参数值就是同一份数据）。表里没有「谁在读」的信息——读的人按身份自己取。
 */
export const useRefreshStore = defineStore('vue-refresh', () => {
  const results = shallowRef<Record<string, Record<string, Entry>>>({})

  const write = (url: string, key: string, entry: Entry): void => {
    results.value = { ...results.value, [url]: { ...results.value[url], [key]: entry } }
  }

  const remove = (url: string, key: string): void => {
    const bucket = results.value[url]
    if (!bucket || !(key in bucket)) return
    const next: Record<string, Record<string, Entry>> = {}
    for (const [name, entries] of Object.entries(results.value)) {
      if (name !== url) { next[name] = entries; continue }
      const kept: Record<string, Entry> = {}
      for (const [entryKey, entry] of Object.entries(entries)) if (entryKey !== key) kept[entryKey] = entry
      if (Object.keys(kept).length > 0) next[name] = kept
    }
    results.value = next
  }

  /** 按身份读一条；没有就是没有（`undefined`），调用方自己决定怎么显示。 */
  const read = (url: string, key: string): Entry | undefined => results.value[url]?.[key]

  /** 只读列举：给 `snapshot()` 这类观测面用，不是包契约。 */
  const list = (): readonly ResultRow[] => {
    const rows: ResultRow[] = []
    for (const [url, bucket] of Object.entries(results.value)) {
      for (const [key, entry] of Object.entries(bucket)) rows.push({ url, key, entry })
    }
    return rows
  }

  return { results, write, remove, read, list }
})
