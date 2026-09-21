import { defineStore } from 'pinia'
import { shallowRef } from 'vue'
import type { ShallowRef } from 'vue'
import { identityOf, splitIdentity } from './core.ts'
import type { ResultCell } from './core.ts'

/**
 * 结果表：每个 (url, key) 一份独立 `shallowRef`，格子里是四个平字段（最后一次成功 ＋ 最近一次失败）。
 * 一个 Pinia 实例一张表。写一格只唤醒订阅这一格的读取副作用；整格换新对象就是「变过」。
 * 实例释放时连 ref 一起删（留着空壳会随历史身份无限长，而 `list` 看不见空壳）；同一个身份重建时 `read`
 * 会建一个新的 ref 并在下一拍被重新订阅，重写照样唤得醒。
 */
export const useRefreshStore = defineStore('vue-refresh', () => {
  const cells = new Map<string, ShallowRef<ResultCell | undefined>>()

  /** 取或建对应 cell ref；首次建时是 `undefined`。 */
  const refOf = (url: string, key: string): ShallowRef<ResultCell | undefined> => {
    const k = identityOf(url, key)
    let ref = cells.get(k)
    if (!ref) {
      ref = shallowRef<ResultCell | undefined>(undefined)
      cells.set(k, ref)
    }
    return ref
  }

  /** 写成功：整格换新对象，失败随之清空。 */
  const write = (url: string, key: string, data: unknown, updatedAt: number): void => {
    refOf(url, key).value = { data, updatedAt, error: undefined, failedAt: null }
  }

  /** 写失败：保留这一格已有的数据与时间，只换掉失败那一对字段。 */
  const fail = (url: string, key: string, error: unknown, failedAt: number): void => {
    const ref = refOf(url, key)
    const previous = ref.value
    ref.value = { data: previous?.data, updatedAt: previous?.updatedAt ?? null, error, failedAt }
  }

  /** 实例释放：这一格连同它的 ref 一起删（键数因此随活跃身份收敛，而不是随历史身份增长）。 */
  const remove = (url: string, key: string): void => {
    cells.delete(identityOf(url, key))
  }

  const read = (url: string, key: string): ResultCell | undefined => refOf(url, key).value

  /** 表里实际有多少格（含已建 ref 但还没写过值的）；给观测面与基准看，不是包契约。 */
  const size = (): number => cells.size

  /** 只读列举：给观测面用，不是包契约；从未写过的格子不列。 */
  const list = (): readonly { readonly url: string; readonly key: string; readonly cell: ResultCell }[] => {
    const rows: { url: string; key: string; cell: ResultCell }[] = []
    for (const [k, ref] of cells) {
      const cell = ref.value
      if (cell === undefined) continue
      const { url, key } = splitIdentity(k)
      rows.push({ url, key, cell })
    }
    return rows
  }

  return { write, fail, remove, read, list, size }
})
