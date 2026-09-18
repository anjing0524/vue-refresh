import type { RefreshCore, Resource, ResultCell } from '../../src/core.ts'

/**
 * 观测面投影：核心私有账本的一份只读计数副本。
 *
 * 这原本是 `RefreshCore.snapshot()`。它不是包契约，只给演示面板、基准脚本与集成测试看状态，
 * 因此不该占用核心的公开成员位：核心只留真正的外部动作（声明、刷新、资格、可见性、销毁），
 * 观测留给测试这一侧。集合是副本、元素仍是核心对象——比较身份正是这些断言的要点，
 * 所以这里是观察面而不是安全边界。
 */
export interface Snapshot {
  readonly resources: readonly Resource[]
  readonly results: readonly { readonly url: string; readonly key: string; readonly cell: ResultCell }[]
  readonly queued: readonly Resource[]
  readonly running: readonly Resource[]
}

/**
 * 唯一被允许越界读取的核心内部账本：三项私有集合加一条结果表列举缝。
 *
 * 核心把这些字段全部声明为 `private`，所以这里用一次 `as unknown as` 显式越界。越界前先做形状
 * 校验：内部一旦改名或换容器就**当场抛错**，而不是静默返回空数组——那样会让断言假通过，
 * 正是「观测面」这种代码最容易出的错。
 */
interface CoreLedger {
  readonly identities: Map<string, Resource>
  readonly queue: Set<Resource>
  readonly running: Set<Resource>
  readonly sink: { list(): readonly { readonly url: string; readonly key: string; readonly cell: ResultCell }[] }
}

const SHAPE_HINT = '（tests/support/observe.ts 的形状视图要同步）'

/** 读一份核心的只读计数投影；核心内部形状漂移立刻抛错。 */
export function snapshot(core: RefreshCore): Snapshot {
  const { identities, queue, running, sink } = core as unknown as Partial<CoreLedger>
  if (!(identities instanceof Map)) throw new TypeError(`观测面：核心的 identities 已不是 Map${SHAPE_HINT}`)
  if (!(queue instanceof Set)) throw new TypeError(`观测面：核心的 queue 已不是 Set${SHAPE_HINT}`)
  if (!(running instanceof Set)) throw new TypeError(`观测面：核心的 running 已不是 Set${SHAPE_HINT}`)
  if (sink === undefined || typeof sink.list !== 'function') {
    throw new TypeError(`观测面：核心的 sink.list() 已不可用${SHAPE_HINT}`)
  }
  return {
    resources: [...identities.values()],
    results: sink.list(),
    queued: [...queue],
    running: [...running],
  }
}
