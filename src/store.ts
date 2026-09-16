import { defineStore } from 'pinia'
import type { Pinia } from 'pinia'
import { shallowRef } from 'vue'
import type { ResultStore, StoreEntry } from './model.ts'

/**
 * Pinia 结果分区适配：把核心的 ResultStore 端口实现为一个私有 Store。
 *
 * 只保存「活跃 Resource 的最近一次有效后台结果」：
 * - 分区表整体替换，且必须浅持有：一旦被 Pinia 深响应式化成 Proxy，交付副本的原生复制就会抛错；
 * - 删除只影响自己的键，页面快照与业务 Store 都不受影响；
 * - 销毁时清空分区、释放 Store 并删除自己的 state 键，应用 Pinia 仍然可用。
 */
export function createResultStore(pinia: Pinia, id: string): ResultStore {
  const useResultStore = defineStore(id, () => {
    const entries = shallowRef<Partial<Record<string, StoreEntry>>>({})

    function put(key: string, value: StoreEntry): void {
      entries.value = { ...entries.value, [key]: value }
    }

    function remove(key: string): void {
      const next = { ...entries.value }
      delete next[key]
      entries.value = next
    }

    return { entries, put, remove }
  })

  const store = useResultStore(pinia)
  return {
    get entries() { return store.entries },
    put: store.put,
    remove: store.remove,
    dispose() {
      store.entries = {}
      store.$dispose()
      delete pinia.state.value[id]
    },
  }
}
