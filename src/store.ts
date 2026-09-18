import { defineStore } from 'pinia'
import { shallowRef } from 'vue'
import type { ShallowRef } from 'vue'
import { identityOf } from './core.ts'
import type { ResultCell } from './core.ts'

/**
 * 结果表：每个 (url, key) 一份独立 `shallowRef`，格子里装的是**最后一次成功 ＋ 最近一次失败**（四个平字段）。
 *
 * **粒度对齐数据**：写一格只唤醒订阅这一格的 `watcher`（vue.ts 的读取副作用依赖的就是
 * 那一个 ref），其余 watcher 不会被多余唤醒。代价是失去 `results` 单一对象可观测——调试期
 * 用 `list()` 列举，或读 `cells.get(...)`。
 *
 * **整 cell 不删**：实例释放时只把 ref 的值置为 `undefined`，不 `Map.delete`。这是因为
 * `watcher` 的依赖是那个具体的 ref 对象——若 `Map.delete` 后再有同一身份的写入，会建一个新
 * ref，watcher 的依赖对象已死，不会被新 ref 唤醒（display 停摆）。保留 ref 让「再写就原地改
 * 同一个 ref」，依赖关系稳定。代价是 Map 不会缩：曾经存在的每个身份都留一份 ref（典型规模
 * 几十份，每份几十字节，可接受）。
 *
 * **写不复制**：`write` / `fail` 直接写 cell ref（整格换新对象）；这正是 `shallowRef`
 * 而不是 `ref` 的原因——`cell.data` 是 `core.ts` 里 `structuredClone(response.data)` 出来的
 * 普通对象，保持普通对象身份才能让消费侧 `structuredClone` 不抛错。格不可变（写时整条换），
 * 所以读到的 `.data` 是结果表里同一个对象，要改自己复制（ADR-52、ADR-59）。
 *
 * **整格换新对象就是「变过」**：读取面比较引用即可决定要不要抄（不引版本号，ADR-63）；
 * 失败那一笔也换新格、但原样带着上一次的 `data` 与 `updatedAt`，所以数据不变而失败可观测。
 *
 * 模块级：一个 Pinia 实例一张表，多个 `createRefreshManager` 共用同一张表也是同一个意思
 * （同一 URL ＋ 同一参数值就是同一份数据）。
 */
export const useRefreshStore = defineStore('vue-refresh', () => {
  const cells = new Map<string, ShallowRef<ResultCell | undefined>>()

  /** 取或建对应 cell ref；首次建时是 `undefined`（＝从未写过）。 */
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

  /** 写失败：**保留这一格已有的数据与时间**，只换掉失败那一对字段。 */
  const fail = (url: string, key: string, error: unknown, failedAt: number): void => {
    const ref = refOf(url, key)
    const previous = ref.value
    ref.value = { data: previous?.data, updatedAt: previous?.updatedAt ?? null, error, failedAt }
  }

  /** 实例释放时把该格清掉（置 `undefined`），但 cell ref 本身保留——见上文「整 cell 不删」。 */
  const remove = (url: string, key: string): void => {
    const ref = cells.get(identityOf(url, key))
    if (ref) ref.value = undefined
  }

  const read = (url: string, key: string): ResultCell | undefined => refOf(url, key).value

  /** 只读列举：给 `snapshot()` 这类观测面用，不是包契约；从未写过的格子不列。 */
  const list = (): readonly { readonly url: string; readonly key: string; readonly cell: ResultCell }[] => {
    const rows: { url: string; key: string; cell: ResultCell }[] = []
    for (const [k, ref] of cells) {
      const cell = ref.value
      if (cell === undefined) continue
      const sep = k.indexOf('\0')
      rows.push({ url: k.slice(0, sep), key: k.slice(sep + 1), cell })
    }
    return rows
  }

  return { cells, write, fail, remove, read, list }
})
