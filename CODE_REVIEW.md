# vue-refresh 代码审查报告（第 6 版 · Linus 视角的对抗性审查）

- 审查对象：`src/`（11 个 TS 源文件，**1770 行**）
- 立场：**不看你怎么想，只看代码说了什么**。本文不采用历史版本的评价口径：那套口径关心"复杂度能不能再降一档"，本版只关心"**哪个输入能让这套东西静默停摆**"
- 文件状态：本文件**只保留本版**。历史报告已移除——它们的基线对应已被删除的 `src/query.ts`、`Delivery` 三态与 `QueryHost`，**行号与模块清单不可用于当前代码**
- ADR 交叉：本报告的多数条目已在 [`ADR.md`](./ADR.md) 中以 ADR-13（v5）/ ADR-14 / ADR-15 / ADR-17 / ADR-18 被同口径复核**（含处置记录与基准漂移清单）**——本版口径与 ADR 一致；**新增结论需给出 ADR 未见过的证据**。
- 基准漂移：本版的基线与 [`CODE_REVIEW.md` 上一版（v5）的实测差异](README) 中已对齐；与 ADR-15 列出的"10 处基线与代码或公开仓库不符"同源——本版重新校准了度量基线。

> **一句话结论（第 6 版 · 自撤 1 条）**：这是一份质量远高于平均水平的实现——注释解释的是"为什么"，不变量有来源，派生值不重复保存，取消立即结算。但它同时在解决一道**自己给自己出的难题**：为了不出现模块环，造了两层只有一种实现"端口"；为了 9e15 次提交不可能出现的计数溢出，在调度热路径上埋了地雷。复杂度没有被删掉，只是被整理得非常整齐。
>
> **本版口径修正（v6.1）**：初稿把"永不 settle 的 `load` 在十条不变量里一条都没提到"立为唯一正确性补丁——**这是评审事实错误**：框架已有 10 秒上限（`manager.ts:18` 的 `LOAD_TIMEOUT_MS` + 行 422 `expireTask`），统一文档 U13 已写"框架上限到期作为兜底"，U20 也明确"框架另有一层上限（U13）作为兜底"。详见 §4 P0-1 撤回声明与 §10「复核记录」。

---

## 0. 度量基线（第 6 版实测）

| 文件 | 行数 | 职责 | 备注 |
|---|---|---|---|
| `src/manager.ts` | **640** | 注册表 + 引用计数生命周期 + 资格判定 + 版本分配 + 结果发布 + 错误隔离 + 销毁编排 | **约 36% 行数、七类职责** |
| `src/model.ts` | 214 | 内部模型与端口 | 11 个 interface；`Handle` 11 字段（4 固定端口 + 7 可变），与 §3.3 DESIGN 表一致 |
| `src/public-types.ts` | 178 | 公共契约 | — |
| `src/scheduler.ts` | 173 | Timer / FIFO / 并发槽位 | 单一职责，拆得干净 |
| `src/vue.ts` | **166** | Vue 适配 | `useRefresh` + 配置快照闭包 |
| `src/source.ts` | 119 | 参数与资源定义边界 | — |
| `src/app.ts` | 101 | 应用边界 | — |
| `src/diagnostics.ts` | **55** | 诊断叶子 | 有意丢弃错误内容（见 P1-3） |
| `src/delivery.ts` | **68** | 结果边界与通知隔离 | — |
| `src/store.ts` | 42 | Pinia 分区适配 | — |
| `src/index.ts` | 14 | 门面 | 契约面钉死，做得对 |
| **合计** | **1770** | — | — |

测试 `tests/core.test.ts` **1110** + `tests/vue.test.ts` 503 + 场景/页面/浏览器 ≈ **2225** 行，测试/生产 ≈ **1.26**。**这个比例不需要我夸，它自己说明问题。**

> **本节校准记录**：上一版（v5）写成 1755 行 / 168 vue / 58 diagnostics / 49 delivery，1085 core.test.ts。差异原因主要是 `delivery.ts` 头部增补 `EFFECT_FAILED` 常量对象（`public-types.ts` 中 `ErrorOrigin.Background = RequestOrigin.Background` 的语义聚合到交付侧），其余为行间空行与注释调整。`Handle` 字段数上一版（v5）写 8（ADR-13）、本版实测 11（4 固定端口 + 7 可变，与 [`DESIGN.md`](./DESIGN.md) §3.3 表一致）。

---

## 1. 数据结构

### 1.1 先记功劳（这些是大多数轮询库做错的地方）

1. **`RefreshWaiter` 用原生 Promise 的 resolver 当 `settle`**（`model.ts:71-76`），注释明写"只有第一次结算生效，因此不需要 settled 镜像"。**对。让标准库干活，不要自己写 `{settled: boolean}`。**
2. **派生值一律不存**（`model.ts:5-10`、DESIGN §3.7）：最短 `every` 现算、任务位置由 `queue`/`running` 归属表达、刷新下限 `refreshFloor` 现算（`manager.ts:502-506`）。没有第二状态机就没有第二状态机的 bug。
3. **同一版本域 + 启动事实**：`Task.version` 与 `RefreshWaiter.minVersion` 同域，`refreshFloor` 用 `Scheduler.isRunning(task)` 区分"排队"与"在执行"（`manager.ts:504`）。只用版本比较会把在途请求误当成"这次动作之后的结果"——很多库就死在这。**这个区分是对的。**
4. **`collectReceivers` 用 `receivers: Set<Handle>` 消掉"同一句柄只交付一次"这个特殊情况**（`manager.ts:423-445`）。不是靠 `if` 堆出来的，是靠集合消掉的。这是好品味。

### 1.2 结构性问题：`Handle` 是一个没有守卫的状态袋

`Handle`（`model.ts:84-107`）是 **11 个字段（4 个固定端口 `source` / `readInput` / `publish` / `onError` + 7 个可变 `cleanup` / `operationId` / `submission` / `subscription` / `refreshes` / `lifecycleActive` / `disposed`）**的状态袋，由 `vue.ts` 创建（`vue.ts:134-146`）、`Manager` 全权改写，两个模块都直接读写字段（`vue.ts:152` 直接读 `handle.disposed`）。[`DESIGN.md`](./DESIGN.md) §3.3 已把"4 固定端口 + 7 可变"写明。

历史版本的表述是"没有统一的状态机迁移函数"。**本版要说得更重：`private handles` 这一层根本没有守住任何东西。**

- `private handles: Set<Handle>`（`manager.ts:43`）只保证"谁能拿到这个对象"，**不保证"谁能改它的哪个字段"**；
- 任何一条路径误写 `handle.subscription`，框架就进入一个注释没覆盖的状态——**编译期不会报错，运行时不会报错，只会在 10 个方法之后的某次 `current*()` 复核里表现成"数据不刷新了"**；
- `manager.ts:536-583` 那 8 个复核函数（`currentOperation` / `eligible` / `present` / `allowed` / `registered` / `currentTask` / `currentSubscription` / `currentWaiter`）**就是这个缺陷的补丁**。你不得不在每个同步重入点手动重新验证事实，因为没有任何东西拦得住状态被写坏。其中只有 4 个以 `current` 开头；`eligible` / `present` / `allowed` / `registered` 4 个名字与命名风格不一致——[`DESIGN.md`](./DESIGN.md) §7.5 只点名了 5 个（漏 `currentOperation` / `present` / `allowed` / `currentWaiter`、含一个幻影名 `deliverable`），**DESIGN 自身存在 baseline drift**。

**该怎么做**：`Handle` 应该是 `Manager` 内部的 class，字段全 `private`，对外只暴露 `{ publish, onError, readInput }` 三个入口 + 一个 `id`。`vue.ts` 不该持有一个能读能写的状态袋，它只需要一个 sink。做完这一步，8 个复核函数能删掉一半——不是因为不需要复核，而是因为写坏的路被堵住了。

### 1.3 `Resource` 的生命周期 = 订阅生命周期，所以 `readSnapshot` 的名字比语义好听

`releaseResourceIfUnused`（`manager.ts:293-305`）：最后一个订阅者与刷新要求都退出时，实例、分区、排队任务一起销毁，**没有 TTL、没有历史缓存**（DESIGN §3.6 有意的）。

后果：`readSnapshot`（`app.ts:93-97`）只能读到**当前有别的页面正在订阅**的那份数据，否则返回 `undefined`。它叫"共享快照"，实际语义是"此刻有活跃订阅时的窥视孔"。这在 README 里被诚实地写成了"不承诺新鲜度"，但**命名仍然在承诺一件它做不到的事**。

---

## 2. 调用链路

```
组件 submit(args)
  └─ useRefresh → prepareParameters(args)   复制 → 冻结 → 稳定编码 → validate    [source.ts:102]
  └─ Manager.submit                          建新 operationId → 存 submission
        → settleRefreshes(Superseded) → 退旧订阅 → requestFlush          [manager.ts:141-152]
     └─ (microtask) Scheduler.flush                                      [scheduler.ts:89]
          ├─ reconcileHandles → synchronize(资格/间隔) + attach(接入共享实例)  [manager.ts:66-72]
          ├─ enqueueDue → 到期者分配 version 入队                         [scheduler.ts:131]
          ├─ startQueuedTasks → 占槽 → Manager.startTask                  [scheduler.ts:143]
          └─ setWakeup(唯一 Timer)                                        [scheduler.ts:165]
     └─ startTask → await load → copyResult → publishResult
          └─ collectReceivers(订阅 ∪ 达门槛的 waiter)
             → cloneSnapshot ×N → deliver → publish                       [manager.ts:405-490]
```

链路本身干净。**问题只有一个，但很实在：**

`submit()` 同步返回 `accepted`，而"把已有结果立刻交付给这个页面"发生在**下一个微任务**里——`commitDeclaration` 只 `requestFlush`（`manager.ts:150`），真正的 `deliver` 在 `attach`（`manager.ts:326`）。

```ts
handle.submit({ id: 1 })   // 'accepted'
handle.display.value       // null —— 明明共享分区里已经有这条数据
```

也就是说，从 `submit` 到 `display` 有值之间存在一段**未定义窗口**：它取决于你是否恰好 `await` 过什么。DESIGN 写的是"`submit` 不隐含刷新"——但"不隐含刷新"与"不交付已有结果"是两件不同的事，你把后者也顺手做了，并且只写在注释里。

**二选一**：要么在 `commitDeclaration` 里同步 attach 一次（并证明其不可重入），要么把 `submit` 变成 async。现在这样，用起来一定有人踩。

---

## 3. 框架设计

### 3.1 两个"端口"不是抽象，是把编译期耦合换成回调表

`ScheduleHost`（`model.ts:181-192`，5 个方法）、`ConfigurationHost`（`model.ts:157-162`，2 个方法），注释反复强调：

> `Manager` 在构造时用一个对象字面量满足它，因此这里不需要转发类。

Linus 式的话：**你没有解耦，你只是把 `Scheduler → Manager` 的编译期依赖，改成了一个只有一种实现的接口。**

判断标准极其简单——**你能想象第二个实现吗？** 不能。`ScheduleHost` 的五个方法（`isDisposed` / `reconcileHandles` / `enqueueTask` / `isCurrentTask` / `startTask`）逐个镜像 `Manager` 的私有方法（`manager.ts:64-77`），第二个实现要重写的就是 `Manager` 本身。这不是端口，是**为了绕开 ESM 环而写的类型体操**。循环 import 是运行时问题，不是设计信号；你为解决它的"形状问题"，付出了"读代码时必须在两个文件间来回跳"的代价。

### 3.2 `Manager` 才是该被拆的那个

`scheduler.ts` 拆得很干净（`Scheduler` 只管"何时、按什么顺序"，173 行，单一职责，值得表扬）。但拆出去之后，`Manager` 里还剩 **7 类职责 / 640 行**：

| 分段 | 行范围 | 职责 |
|---|---|---|
| 状态观测 | 81-101 | `inspect()` 投影 |
| 页面操作 | 103-202 | `submit` / `refresh` / `readSnapshot` |
| 需求关系 | 204-354 | 资格、attach、注册表、引用计数 |
| 后台执行 | 356-490 | 任务执行、发布、错误 |
| 刷新要求 | 492-523 | 门槛、补位、结算 |
| 有效性与身份 | 525-596 | 8 个复核函数 + 计数分配 |
| 释放 | 598-640 | 句柄与 Manager 销毁（至类结尾） |

历史版本提出的路线图（把 `Manager` 拆成 6 个协作者类）方向是对的。本版补充一条**优先级判断**：先做 §1.2 的 `Handle` 私有化，再谈拆类。因为现在拆出来的 6 个类**仍然要共享那个可变 `Handle`**，等于把 640 行的上帝类变成 6 个共享全局状态的类——**更糟**。

### 3.3 另外三处

- **`bindings: WeakMap<App, RefreshBinding>`（`app.ts:27`）是模块级隐藏全局状态**，存在的唯一理由是为了"原地换 Manager"。但 `provide` 本来就支持替换，是你自己选了 `installedApp` 单次绑定（`app.ts:65`）才需要这张表——**这两条规则在互相打架**。
- **`store.ts:15` 在函数里调 `defineStore`**，`store.ts:39` 直接 `delete pinia.state.value[id]` 捅 Pinia 内部结构。前者违反 Pinia 明确要求（必须模块级定义，否则 devtools/HMR 会看到重复定义），后者是对私有实现的依赖。**注释里写了，不等于可以。**
- **`package.json:36-39` 的 `peerDependencies` 精确钉死 `vue@3.5.42` / `pinia@4.0.3`**。库对 peer 做 exact pin = "你的应用必须正好用这个版本"。这会把消费方逼疯。

---

## 4. 必须修的问题（按严重度排序）

### P0-1 · 一个永不 settle 的 `load`，会让整个 Manager 慢性死亡 — **撤回**（v6 评审初稿写成"框架侧缺超时"是漏读）

**v6 评审初稿的问题**：

- **漏读了 `LOAD_TIMEOUT_MS = 10_000` + `expireTask`（`manager.ts:18, 394, 422-432`）**——注释明确写"数值由确认人给出（2026-09-16 裁决）"
- **漏读了 [`统一刷新管理.md` U13](统一刷新管理.md:318)**：「后台 FIFO 并发槽统计真实未结束的 `load`；取消不提前释放槽，**框架上限到期除外**——上限从任务真正开始执行起算（排队不计入），到期按共享请求失败结算、立即出册并交还槽位」
- **漏读了 [U20](统一刷新管理.md:349)**：「HTTP 适配负责业务 schema、**业务超时**与认证……框架另有一层上限（U13）作为兜底」

也就是说：**框架不仅已经有 10 秒上限兜底，而且规范文档已经把"框架上限"作为兜底显式写入**。v6 初稿把"框架没超时"当成唯一正确性补丁——**框架其实已经有了**。

**撤回之后剩下什么**：

- **ADR.md 已裁决清单漏记这次 2026-09-16 的 LOAD_TIMEOUT_MS 裁决**——属于 ADR baseline drift（见 §10.4）；按 ADR 维护规则"每条裁决一经登记即关闭"，**这次新增应当作为 ADR-19 登记**
- **DESIGN §5.2 的注释需要把"2026-09-16 裁决"对应到 ADR-19 引用**（目前是裸值）
- **§6.4.3 故障族清单**如果还停留在初稿"5 个有限故障族"的旧表述，应补"框架上限到期"作为第 6 个兜底故障族（**注**：本评审未实测 §6.4.3 当前是否已更新——见 §10.4 的"基线漂移是已知现象"原则，应先实测再决定）

**评审可信度问题**：本评审 §4 P0-1 的初稿把"框架缺超时"立为本版**唯一**正确性补丁，再被本审自己打回去——这是评审者最低级的失误，比"漏读 ADR"严重得多。**§10 整节"复核记录"也连带失信**（§10.2 第三行"P0-1 适配器契约范围 1 条"是基于错误事实的）。本次评审应先撤销 §10 的 P0-1 行，再讨论其余条目。

> **不在本版改动范围**（自顶向下读时易混淆）：v6 初稿把 P0-1 立为唯一正确性补丁——本节是该初稿的**撤回声明**，不是新的 P0 条目。

### P1-2 · `nextIdentity` 溢出即销毁整个 Manager，而且就在调度热路径上

`manager.ts:589-596`：`previous >= Number.MAX_SAFE_INTEGER` 时 `this.dispose()` + 报错。[`ADR-12`](./ADR.md) 已实测该提案（改 `throw`）只减 5 行（非评审估算的 −12）且把 §2.4 的 `submit` 返回契约改成同步抛错——**该方向已被裁决**，本版的"删除或退化为不再分配 `null`"尚未被 ADR 评估。

二次开发的现实是：这需要 9e15 次提交，**不可能发生**。这不是防御，是**为不可能发生的事在热路径上埋地雷**：

`enqueueTask`（`manager.ts:364`）会在 `Scheduler.enqueueDue` 遍历 `this.buckets` 的 generator 中间被调用（`scheduler.ts:136`），而 `dispose()` 会在这条遍历进行中删掉 Map 里的桶。JS 的 Map 迭代对删除是安全的，所以**不会崩**——但这行代码的存在本身就说明你在为不会发生的事写逻辑。更糟的是它选的失败模式：**整个 Manager 报废**。数据一致性出问题时，你最不需要的就是"把整个框架炸掉"。

**删掉**；或退化成"不再分配 `null`"，而**不销毁 Manager**。计数器溢出是理论问题，`Infinity`/`NaN` 才是工程问题。

### P1-3 · `diagnostics.ts` 造了一条拒绝携带调试信息的调试通道

`delivery.ts:49-51`：

```ts
} catch {
  reportObserverError(OBSERVER_FAILED, identity)   // ← 原始异常被直接丢弃
}
```

`diagnostics.ts:26-39` 里 `reportObserverError` 只写固定字符串；文件头还郑重声明"**不读取原异常的 message/stack/cause**"。

动机我理解（不泄漏业务数据、不信任 `console`）。但结果就是：业务方的 `onError` 抛错了，控制台打出一行 `observer notification failed`，**然后什么都没有**。用户拿着这行字去排查问题，唯一的出路是改你的源码。

**修法**：`reportObserverError` 至少应接受原始 error，并由**框架**决定输出什么（例如只打 `error.constructor.name`）。你要的是一个可关掉的诊断口，不是一个哑掉的。（成本账见 §7.3）

### P1-4 · `readSnapshot` 说"只读定位、不复制不冻结"，实际是 O(参数规模) 的两趟全量遍历

`app.ts:93-97` → `parameterKey(args)` → `buildKey(input, false)`（`source.ts:80-86`）→ **完整递归校验每个节点** + **完整 stable stringify**。

README 把它定位成"只读共享结果"的轻量入口，并明确"要判断数据新旧就用 display"——那就意味着它会被用在**渲染路径**上（`examples/pages/shared-pair.ts:119` 就是这么用的）。参数里一含数组，就是每次渲染两趟全量遍历，且框架自称"不设字节上限"（`source.ts:55-57`）。

另外两个契约裂缝：
- `readSnapshot` 对非 JSON 参数会抛 `TypeError`（`source.ts:82`），而签名只写了 `| undefined`；
- 它**不跑 `validate`**，因此"`submit` 会拒绝的参数，`readSnapshot` 照样去查"——两条入口的合法性判据不一致。

### P2-5 · "所有业务回调都被隔离"这句话不成立

`delivery.ts` 头注释列举了 `publish` / `onError` / `cleanup` / Store 通知四类。但你把 `AbortSignal` 交给了 `load`（`public-types.ts:86`），业务方在 signal 上挂监听是完全正常的用法，而 `controller.abort()`（`manager.ts:304`）**不在任何 `observe()` 里**。隔离承诺有一道门没关。

### P2-6 · `publishError` 忽略 `minVersion`——有意的，但语义上是个洞

`manager.ts:469-471` 把该实例**全部**未结算要求按同一失败结算。[`DESIGN.md`](./DESIGN.md) §3.6 给了理由：否则"仍有未满足要求"会立刻触发再登记 = 失败即自动重试。**这个理由成立，我接受"失败不自动重试"。**

但它有个副作用文档没提：`refresh()` 的 floor 是 `task.version + 1`（语义是"我要一个在我这次点击之后**启动**的请求"），而这次点击却会被一个**早于点击就已发出**的请求的失败结算掉。**用户在 A 时刻点刷新，拿到的是 A 之前那次请求的失败。** 要么按 floor 过滤、把更高门槛的要求留给后继任务（配合显式重试节流），要么就别在文档里声称 `refresh()` 表达"我这次动作要求的下限"。

### P2-7 · API 人体工学：两个必填项在逼用户撒谎

- `RefreshOptions.enabled` 与 `every` 都是必填（`public-types.ts:143-145`），`every` 还必须是正安全整数。**一个只想手动刷新的页面必须写 `{ enabled: false, every: 1 }`**——用一个假数字表达"没有周期"。
- `public-types.ts:132-137`：整个 `options` 对象是 setup 期捕获的，换对象不生效，要动态切换必须"让字段本身是 Ref"。**这是 API 设计错误被写成了使用须知。** Vue 用户换 `options.value = {...}` 是肌肉记忆，你不可能靠注释拦住他。要么在 `useRefresh` 里对 `options` 做一层重建订阅，要么签名只接受 `Ref`/getter。
- `public-types.ts` 的 `DeepReadonly<T>` 是**编译期声明**：`cloneSnapshot` 用 `structuredClone` 产出的对象**没有冻结**（`delivery.ts:25-27`）。这不构成别名 bug（每份都是独立副本），但类型在对调用方承诺一件运行时没做的事——**要么冻，要么别叫 DeepReadonly**。

### P2-8 · 三处 `as` 类型洗白

`source.ts:43`（`as unknown as RefreshSource`）、`source.ts:47`（品牌擦除）、`vue.ts:137`（`value as RefreshDisplay<P, T>`）、`app.ts:96`（`as DeepReadonly<T> | undefined`）。

每一处都是一张**没有证明的收据**。品牌字段那处是必要之恶（运行时确实只剩两个回调），但 `vue.ts:137` 与 `app.ts:96` 完全可以靠"`Manager` 泛型化"或"交付值先冻结"来消除。

---

## 5. 如果我来写

保留 90% 的不变量，删掉一半的代码：

| # | 动作 | 收益 |
|---|---|---|
| 1 | `Handle` 变成 `Manager` 内部 class，字段私有；`vue.ts` 只拿 sink 端口 | 删掉一半 `current*()` 复核；`DESIGN §3.3` 的表从文档变成结构事实 |
| 2 | （撤回：P0-1 已实现；详见 §4 P0-1 撤回声明） | — |
| 3 | 合并 `ScheduleHost` / `ConfigurationHost`：让 `Scheduler` 直接持有 `Manager` 的窄引用，或把 `Manager` 拆成 `Registry` / `Policy` / `Publisher` 三个小类 | 端口只保留一种实现就删掉；读代码不用跨文件跳 |
| 4 | `nextIdentity` 溢出处理删除（P1-2） | 热路径去掉一个不可能分支 + 一个恐慌式失败模式 |
| 5 | 诊断保留 error 对象，只过滤输出内容（P1-3） | 排障从"改源码"变回"看日志" |
| 6 | 参数定位拆两条路径：`readSnapshot` 用调用方给的稳定 id，别每次全量 stringify（P1-4） | 渲染路径从 O(n) 变 O(1) |
| 7 | `submit` 同步交付已有结果，或改成 async——**二选一，别留窗口** | 消除调用方的隐式 await 依赖 |
| 8 | 错误分类压平：删两个 `Exclude`、拆开 `'background'`、`RefreshError` 带上 `operationId`（§7） | 分类刚够用，且多句柄页面能认领错误 |

---

## 6. 不在本版改动范围（正面清单）

以下是被本版**明确认定不构成问题**的设计，读代码时不必再质疑：

1. `defineRefresh` 返回冻结对象、品牌字段只在类型层（`source.ts:37-44`）——必要之恶，正确；
2. `RefreshSource` 用 `args: (value: P) => P` 把 `P` 钉成不变型，无法用更宽泛型绕过——**好设计**；
3. **用常量对象 + `keyof typeof` 推导状态取值域，不用 `TS enum`**（`public-types.ts:23-29` 等，受 `erasableSyntaxOnly` 约束）——**好设计**。注意：这里肯定的是**手法**，不是 `ErrorOrigin.Background` 复用 `RequestOrigin.Background` 这个**字面量**（那件事见 P2-10）；
4. `RefreshWaiter` 用原生 Promise resolver，不做 settled 镜像（`model.ts:71-76`）——**好设计**；
5. 派生值不存（DESIGN §3.7）+ `collectReceivers` 用 Set 消重（`manager.ts:423-445`）——**好设计**；
6. `Scheduler` 的 `MAX_TIMER_DELAY` 分段等待（`scheduler.ts:20,167`）、`dueAt` 的"时钟只读一次"约束（`scheduler.ts:118-122`）——**踩过坑才写得出的注释**；
7. `store.ts` 用 `shallowRef` 而非 `ref`（避免 Pinia 深代理破坏 `structuredClone`）——注释说明了原因，判断正确；
8. `index.ts` 逐个列出导出类型而非 `export type *`——把契约面钉死，正确；
9. **`readConfiguration` 三项各自独立 `try/catch`**（`vue.ts:50-68`）——它是 watcher 的取值函数，提前 throw 会让后两项丢掉依赖收集。**这不是多余的防御**（完整讨论见 §7.2）；
10. **配置非法的电平通道**（`Input` 部分快照 + `reported` 去重 + `ErrorOrigin.Configuration`）——本版曾准备判为臃肿，读完代码后**撤回**（见 §7.2）。

---

## 7. 错误处理专项（第 6 版补充）

### 7.1 账目：9.2%，不算离谱

| 类别 | 位置 | 行数 |
|---|---|---|
| 错误/取消类型 | `public-types.ts:38-46, 48-53, 55-67, 69-73, 94-97, 104-107, 114-117` | **45 / 178 ≈ 25%** |
| 隔离与诊断层 | `diagnostics.ts` 全部 | 55 |
| 交付侧隔离 | `delivery.ts:33-52` + 头注释 | ~30 |
| 隔离调用点 | `manager.ts:303, 410, 484, 616, 635, 638`；`delivery.ts:51`（`observe` 内调用 `reportObserverError`）；`source.ts:113` | 8 处 `observe` + 2 处 `notify` 出口（`manager.ts:128, 465`） |
| **合计** | | **约 160 / 1770 ≈ 9.0%** |

**9.2% 本身不离谱。** 离谱的是这 9.2% 里的结构：**"隔离"花的钱合理，"分类学"和"诊断"花的钱基本白花。**

### 7.2 先撤回一处：配置非法的电平通道**不是**臃肿

`snapshot` 部分快照（每项可为 `null`，`vue.ts:45-74`）+ `reported` 去重标志（`vue.ts:99, 107-111`）+ `ErrorOrigin.Configuration` + `refresh` 的 `configuration` 分支（`manager.ts:175`）。

本版初读时准备判它臃肿：**"配置是 setup 期的编程错误，`readBoolean` 已经在抛 `TypeError` 了，为什么还要建模成一个可运行的电平状态？"**

**这个批评是错的。** 反例成立且常见：

```ts
useRefresh(source, { enabled: computed(() => store.ready && store.on), every: 5000 })
```

`store.ready` 为假时这是一个**合法的暂态非法配置**，稍后会自行变为 boolean。为此，保留电平快照、不把读不到的开关推断成 `false`、连续非法只通知一次——**机制本身是对的，一行都不该删。**

**但真正的问题在文档**：支撑这约 40 行机制的场景，DESIGN 里一句都没写。读到这里的人（包括本版）第一反应都是"删掉它"。**这是文档债务 D-1。**

### 7.3 四个真问题

#### P2-9 · 用 `Exclude` 求差集，把"哪个动作会失败成什么样"藏起来

```
RefreshErrorOrigin = Exclude<ErrorOrigin, 'validation'>        [public-types.ts:53]
SubmitCancelReason = Exclude<CancelReason, 'unavailable'>      [public-types.ts:73]
```

注释给的理由（"成员改名时这里会一起报错，不留语义上已不存在的取值"）成立。但它修补的是一个**设计问题**：`submit` 与 `refresh` 是两条语义不同的通道，各自能产生哪些失败是**动作的固有属性**，却被表达成"全集减掉一个"。

代价立刻出现：想知道"`submit` 会返回什么"，你得读三个类型 + 在心里求两次差集。**`Exclude` 省了 6 行字面量，收走了每个读者的推理成本。**

**修法**：在签名里写全可达子集，别让类型系统替你算减法。

#### P2-10 · 一个字符串干两份活：`'background'`

```ts
ErrorOrigin.Background = RequestOrigin.Background   // public-types.ts:39-40
```

注释说这是有意的（"主动刷新与自动刷新走同一条获取路径，因此共用这个取值"）。但实际结果是**同一个字符串在两个字段里表达两件不相关的事**：

- `display.origin === 'background'` → 这条结果是自动轮询来的
- `error.origin === 'background'` → 共享请求失败了（不管谁触发的）

而这两个字段会**同一时刻出现在同一个页面**（`display` 与 `onError` 是两个并列的对外出口）。页面里写下 `if (x.origin === 'background')` 时，必须先确认自己站在哪条通道上看这条字符串。

**收益：少一个常量。成本：一个持续误读点。** 这是为了整齐牺牲清晰。

**修法**：错误来源改名（`'request'` / `'load'`），或让 `ErrorOrigin` 与 `RequestOrigin` 彻底解耦。

#### P2-11 · 分类学很丰富，定位信息却是被刻意剥掉的

`RefreshError` 只有 `{ origin, error }`（`public-types.ts:94-97`）。DESIGN 的理由是 `operationId` / `resourceId` / `taskVersion`"无法被调用方用于比较或续传，只在 observer 诊断事件里做日志关联，不进公开契约"。

**这个理由有一半不成立**：一个组件里出现两个 `useRefresh`（或一个页面同时订阅两份数据）时，`onError` **没有任何办法告诉你这是谁的错**。

它当然不需要 `taskVersion` 参与比较——但"**这是哪个句柄的失败**"是调用方**能做、且必须做**的判断，你把它和 `taskVersion` 一起丢掉了。结果：

- 日志里有身份，但**没有错误内容**（P1-3）；
- 回调里有错误，但**没有身份**（本条目）。

**两边各拿一半。** 这和"臃肿"是同一个病的两面：你为分类建了 5 个类型，却把 1 个真正有用的定位字段挡在门外。**至少把 `operationId` 放进 `RefreshError`。**

（P1-3 的成本账也就清楚了：**这条诊断通道付出了 55 行 + 8 个调用点的纪律，买回来的是"固定字符串"，而它本该提供的身份关联能力，恰好被同一个"不带框架身份"的原则从公开回调里也切掉了。**）

#### P2-12 · `observeRejection` 半暴露

`observe`（`delivery.ts:46-52`）= `try/catch` + `observeRejection`；而 `observeRejection`（`diagnostics.ts:48-55`）单独导出后只被 `source.ts:113`（`ASYNC_VALIDATE`）用了一次。

两者共用一个出口是对的，但读者要读两遍才能确认"`observe` 同时覆盖同步抛错与异步拒绝"。**建议**：要么让 `source.ts` 也走 `observe`，要么在 `observe` 的注释里显式点明覆盖关系。

### 7.4 削减清单

| 动作 | 位置 | 收益 |
|---|---|---|
| 删两个 `Exclude`，签名里写全可达子集 | `public-types.ts:53, 73` | 读者不用求差集（P2-9） |
| `ErrorOrigin.Background` 拆开撞名字面量 | `public-types.ts:39-40` | 消除持续误读点（P2-10） |
| `RefreshError` 加 `operationId` | `public-types.ts:94-97` | 多句柄页面能认领错误（P2-11） |
| `reportObserverError` 收下原始 error | `diagnostics.ts:26-39` | 诊断从"没有"变"有"（P1-3） |
| DESIGN 补写"配置暂态非法"场景 | DESIGN §3.8 附近 | 防止下一个人误删 40 行（D-1） |

**做完这五条，错误处理从"分类过度 + 信息不足"变成"分类刚好 + 信息够用"，代码只减不增**（纯减约 15 行）。

### 7.5 文档债务

**D-1 · 配置暂态非法的场景未进 DESIGN。** `Input` 的三值语义（`true` / `false` / `null` 表示"读不到"）、`reported` 去重的必要性、以及"为什么不在首次非法时同步抛错"，目前只存在于 `vue.ts:50-74` 的注释里。§7.2 已论证该机制正确——**正因如此，它必须写进设计文档**，否则它会在下一次重构里被当成"过度设计"删掉，而删掉之后 `enabled: computed(() => store.ready && ...)` 这类写法会静默失效。

---

## 8. 结语

这份代码的注释质量，是业务仓库里基本见不到的水平——它解释的是"为什么"，是不变量的来源，是踩过的坑。1000+ 行核心测试 + Playwright 页面用例，README 敢写"不设性能阈值，只在超限或残留时非零退出"。**这些都不是糊出来的。**

但正因为质量高，本版更要把话说直：

**你在回答一道自己出的难题。** 真实问题是"N 个组件共享一条轮询，数据不许串味，取消要立即结算"。这个问题的答案不该是 1770 行、11 个模块、两层端口、一个 640 行的上帝类。

**你没有把复杂度删掉，你把它整理得非常整齐**——整齐到每一条都能找到注释解释，但它还在那儿。

> **本版口径修正（v6.1）**：本节初稿把"永不 settle 的 `load` 没在十条不变量里"作为复杂度未删的证据——**这条论据本身是评审事实错误**：框架已有 10 秒上限（`manager.ts:18` 的 `LOAD_TIMEOUT_MS` + 行 422 `expireTask`），U13 把"框架上限到期"作为兜底写入。复杂度确实还在，但**这不构成"框架缺超时"的论据**。详见 §4 P0-1 撤回声明与 §10 复核记录。

错误处理是同一个故事的小号版本：~9.0% 的行数、5 个类型、两层隔离，**隔离做得对，分类建得多，而真正需要的两个信息（错误内容、错误归属）各被切掉了一半**——其中"错误归属"的一半（[`DESIGN.md`](./DESIGN.md) §3.8 的"框架身份不进公开契约"）是显式设计，需先推动 §3.8 重裁才能反转（见 §10 复核记录）。

整理得再整齐的复杂度，也挡不住一个没想到的输入。

---

## 9. 简化潜力（针对"500 行够不够"的回答）

> **用户原问**："这点需求 500 行代码都能写完了，现在都写了 2000 行。"  
> **结论**：约束是真的；实现里大约 **30% 是补漏层**，不是设计。砍掉这一层仍约 1200 行；**500 行需要的是约束重写**，不是技术决策。

### 9.1 把账劈开

| 部分 | 行数 | 性质 |
|---|---|---|
| `scheduler.ts`（FIFO、并发槽、分段 Timer、`isRunning(task)` 区分"排着/在执行"） | 173 | 真有活 |
| `source.ts`（参数复制/冻结、稳定编码、循环守卫、`validate`） | 119 | 真有活 |
| `store.ts`（Pinia 私有分区、`shallowRef` 避开深代理破坏 `structuredClone`） | 42 | 真有活 |
| `vue.ts` 去掉 `readConfiguration`/`reported` 残留后的部分 | ~120 | 真有活（三个 watcher + 生命周期） |
| `app.ts` + `index.ts`（安装绑定、SSR 边界、契约面） | ~80 | 真有活 |
| `manager.ts` 的子集：注册表 + RefCount + 资格 + 同次整体发布 + 取消结算 | ~280 | 真有活 |
| `diagnostics.ts` + `delivery.ts` + 8 处 `try/catch` 隔离 | ~80 | 真有活（隔离纪律） |
| **真有活小计** | **~860** | |
| 解释型注释（说明既有机制的合理性，DESIGN 同步存在） | ~150 | 必要 |
| `Handle` 11 字段（4 固定 + 7 可变）+ 8 个复核 | ~150 | **补漏** |
| `ScheduleHost` / `ConfigurationHost` 两个"端口" | ~60 | **补漏** |
| 错误类型分类学（`ErrorOrigin` + `RefreshErrorOrigin` + `CancelReason` + `SubmitCancelReason` + 两个 `Exclude`） | ~50 | **补漏** |
| `reportObserverError` 哑诊断（55 行 + 8 处调用纪律） | ~30 | **补漏** |
| `readConfiguration` 三项独立 try/catch + `reported` 去重 + `Configuration` 来源 | ~50 | 可简化（非补漏，但见 9.4 注 1） |
| `nextIdentity` 溢出即 `dispose` | ~20 | **补漏** |
| `readSnapshot` O(n) 两趟全量遍历 + `DeepReadonly` 编译期撒谎 | ~10 | 类型与运行时不一致 |
| 其余必要类型 / 边界值 | ~225 | 必要 |
| **合计** | **1765** | |

**30% 是补漏**——它不在"复杂度本应有的部分"里，而是为了治前面章节诊断出的根病（Handle 可写字段、`ScheduleHost` 零实现、错误分类学过度、`diagnostics` 哑诊断等）**反复打的补丁**。

### 9.2 "补漏"长什么样——以下六处都是补丁对补丁

1. **`Handle` 公开 11 个字段（4 固定 + 7 可变）→ 8 个复核函数作为补丁**（§1.2、附录 B S-1）：根病是字段没私有化，复核是治这个病的药。**真设计**是 `Handle` 收进 `Manager` 作私有 class，`vue.ts` 只拿 sink，**8 个复核函数能砍掉一半**。**注意**：[`ADR-13`](./ADR.md) 已把同类提案（STATE-02 / API-04）列为"会新增 `Handle` 持久字段"并拒绝——本版的"−150 行"估值与 ADR-13 / ADR-15 实测（类似改动 −5 至 −18 行）量级偏差较大，重开需提供 §9.4 估值之外的证据。
2. **`ScheduleHost` / `ConfigurationHost`：两个接口、零个第二实现**（§3.1、附录 B S-4）：注释自己承认"Manager 在构造时用一个对象字面量满足它"。**这是为了绕开 ESM 环写的类型体操**，不是抽象。删接口、让 `Scheduler` 直接拿 `Manager` 窄引用。
3. **`ErrorOrigin` + `RefreshErrorOrigin` + `CancelReason` + `SubmitCancelReason` + 两个 `Exclude`**（§7.3 P2-9/P2-10、附录 B）：5 个类型表达 4 个真实分支。`Exclude` 修补"枚举取值和产生它的动作不匹配"的设计问题。**真设计**是判别式联合 + 每个动作写全可达子集。
4. **`'background'` 一字两用**（§7.3 P2-10）：`display.origin` 与 `error.origin` 共用同一字面量表达两件不相关的事。**收益：少一个常量；成本：一个持续误读点。**
5. **`reportObserverError` 只收固定字符串不收 error**（§4 P1-3、§7.3）：55 行 + 8 处纪律，换回的是 `console.error('[vue-refresh]', {origin: 'observer', error: 'observer notification failed'})`——**字段名 `error`，值是固定字符串**。成本明确，收益为零。
6. **`nextIdentity` 溢出即 `dispose`**（§4 P1-2）：理论上 9e15 次提交不可达，选了一个"恐慌式失败"模式，**在调度热路径上**。

### 9.3 500 行的版本需要什么

**500 行够。但前提是改约束，不只是改代码。** 当前 132 条验收叶子带 47+ 子项、十几个变体，是**让代码不得不长**的真正原因。

如果把约束简化到核心 30 条——

- 砍 `every: 1` 假数字（manual-only 时允许省略 `every`）
- 把 `cancelled` 合并（不分 `superseded` / `unavailable` / `disposed`）
- 把 `ErrorOrigin` 收成 1 类
- `readSnapshot` 不再独立分区（直接读 Pinia 分区或退回裸 Map）
- `enabled` / `every` / `visible` 改成 setup 期同步抛错而非电平状态
- `refresh` 失败策略直接失败（不再"保留旧画面"）
- 砍 `F10` / `F12` / `F13` / `F14` / `F15` 那一组时序再入的极端变体

——500 行可写：`Map + RefCount + 单 Timer + 显式 waiter + 8 处 try/catch + Vue watcher + Pinia 适配 + 门面`。

**但不应为了行数改约束**——132 条验收叶子是签字的产品边界。约束重写是签字权的事，不是技术决策。

### 9.4 不改约束、砍实现：约 −270 行的具体动作

| 动作 | 减行 | 风险 |
|---|---|---|
| `Handle` 收进 `Manager` 作私有 class，`vue.ts` 只拿 sink | **−150** | 8 个 `current*()` 砍半；字段误写编译期挡住（S-1 + P1-3 周边 P2-12 顺带） |
| 删 `ScheduleHost` / `ConfigurationHost`，让 `Scheduler` 拿 `Manager` 窄引用 | **−60** | 跨文件读消除；零实现的"端口"拿掉（S-4） |
| `RefreshError` 加 `operationId`；合并 `ErrorOrigin` / `RefreshErrorOrigin`、`CancelReason` / `SubmitCancelReason` 为判别式联合 | **−50** | 公开契约面**扩**（多一个字段），实现类型**缩**（P2-9 / P2-10 / P2-11） |
| `reportObserverError` 收原始 error，由框架决定输出 | **−15** | 诊断从"哑"变"真"（P1-3） |
| 删 `nextIdentity` 溢出处理 | **−15** | 不可达分支从热路径上摘掉（P1-2） |
| DESIGN 补"配置暂态非法"场景一段（D-1） | **+15** | 防下个人误删 40 行 |
| **合计** | **−275** | |

**1765 − 275 = 1490 行**（**注**：1765 是 §9.1 表的"含必要类型/边界值"估值，不等于 §0 实测的 1770；按 §9.1 表对账更稳）。叠一轮"管理两遍精简"（拆分 `Registry` / `Policy` / `Publisher`，**这一步以 S-1 为前置**）可再压到 **~1200 行**。

> **§9 与 ADR 的口径冲突**：[`ADR-12`](./ADR.md) 实测"`nextIdentity` 改 `throw`" 减行数为 5（非评审估算的 −12），且违反 §2.4 契约；[`ADR-14`](./ADR.md) 实测同类精简合计 −23（含 D1）／−18（不含 D1）；[`ADR-15`](./ADR.md) 实测"`query` runner 可选化"为 0 行；本版 §9 表的估值与 ADR 实测**整体乐观**——若实施前重新实测，§9.4 的"−275 行"很可能是"−100 行左右"。

> **注 1**：`readConfiguration` 三项独立 `try/catch` **不在砍列表里**（§6.9 已判定为正面条目 R-1）——它是 Vue watcher 取值函数，提前 throw 会让后两项丢掉依赖收集。**不是补漏，是 Vue 的硬约束**。`reported` 标志与 `Configuration` 来源也属"为合法暂态非法场景设计"，机制正确，**唯一缺的是 D-1 那段文档**。

---

## 10. 复核记录（与 ADR / DESIGN / 统一文档的交叉对照）

本节为第 6 版新增的"复核记录"，与前 9 章互补：前 9 章给出本版评审结论，本节记录这些结论与 [`ADR.md`](./ADR.md) / [`DESIGN.md`](./DESIGN.md) / [`统一刷新管理.md`](./统一刷新管理.md) 的**已知裁决与文档锚点**的对照结果。

> **§10 的可信度声明**：本节初稿把"P0-1 永不 settle 的 load 不在 §6.4.3 故障族、U20 把超时归 HTTP 适配器"当作评审核心结论之一，**这是一次事实错误**——框架已有 10 秒上限（`manager.ts:18` 的 `LOAD_TIMEOUT_MS` + 行 422 `expireTask`）、统一文档 U13/U20 已写入"框架上限作为兜底"。**初稿评审者把已实现的修补误判为缺口**。本节所有与"P0-1"相关的统计与表格均按"撤回"重新计算。

### 10.1 三个文档的互补性

- **DESIGN.md §3 / §4 / §7** 是本评审的"答辩"。评审中能对应到设计取舍的条目（P2-6 / P2-9 / P2-11 / S-1 等），在 DESIGN 里都能找到**显式的取舍依据**——不读 DESIGN 会把这几处当 bug 提，其实是写好的设计。
- **统一刷新管理.md §3 / §6.4.3** 是本评审的"测试方法论门槛"。§6.4.3 的故障族清单与 U13/U20/U25 等条款共同构成"评审未扫的对照表"。**本评审初稿对 §6.4.3 的 5 个故障族数与 U20 内容的引用都不准确**——已实现"框架上限"作为兜底（U13），U20 也明确说"框架另有一层上限（U13）作为兜底"。**评审的失误不在文档，在评审自己漏读了文档与代码**。
- **ADR.md** 是本评审的"裁决史"——但 ADR.md 自身也漂。已确认 4 处 ADR 判断与代码不符（ADR-15 `Handle` 写 10 字段实测 11；ADR-17 `cancelRefresh` 改名未落地；ADR-17 "`ConfigurationHost` 仍是 3 项"被 ADR-18 推翻成 2 项；ADR-13 硬反例 1 处前提已失效）。**评审若要重开，必须给出 ADR 未见过的证据；ADR 若要继续被引用，也必须先重新校准**。

### 10.2 本版对照结论

| 类别 | 数量 | 处理 |
|---|---|---|
| **本评审事实错误** | 1 条（P0-1 撤回） | §10 整节统计需按 26 条重计；初稿"框架缺超时"立论作废 |
| **未翻盘、未与已裁决 ADR 重叠** | 10 条（P1-3、P1-4、P2-5、P2-7、P2-8、P2-10、P2-12、S-2、S-3、D-1） | 保留，§10.3 列对应改进路径 |
| **翻盘（与 DESIGN 显式取舍冲突）** | 2 条（P2-9、P2-11） | 评审若要立论，需先推动 DESIGN §3.6 / §3.8 重裁 |
| **与 ADR-11/12/13/14/15/17 已裁决的同源结构提案** | 6 条（P1-2、S-1、S-4、S-5、S-6、S-7） | 重开需 ADR 未见过的证据；§9 简化潜力的估值（−275 行）与 ADR 实测整体乐观 |
| **正面清单 / 已撤回** | 10 条（R-1 ~ R-10） | 不构成问题，与 ADR 无冲突 |
| **独立诊断口 / 独立文档债务** | 1 条（P1-3 + D-1） | 无 ADR 关联，独立可推 |
| **新增未登记裁决** | 1 条（LOAD_TIMEOUT_MS 2026-09-16） | 应作为 ADR-19 登记；DESIGN §5.2 注释需加 ADR-19 锚点；如 §6.4.3 未更新"框架上限到期"故障族应同步补 |

### 10.3 改进路径（按"先动文档、再动代码"的次序）

1. **推动文档裁决**——`DESIGN.md` §3.6 / §3.8 重裁（P2-6 / P2-9 / P2-11）；本评审 §10.2 翻盘 2 条在此项推进。**P0-1 已从这一项撤掉**。
2. **登记新增裁决**——`ADR.md` 增补 **ADR-19**（`LOAD_TIMEOUT_MS = 10_000` + `expireTask`，2026-09-16 裁决）；`DESIGN.md` §5.2 注释的"2026-09-16 裁决"加 ADR-19 引用；如 §6.4.3 故障族清单未更新"框架上限到期"，应同步补。
3. **补 DESIGN 文档债务**——D-1（配置暂态非法场景）独立可推，零风险但防机制被误删。
4. **结构级提案**——S-1 / S-4 / S-5 / S-6 / S-7 需先给 ADR 未见过的证据，不能直接实施；其中 S-1 / S-4 / S-6 / S-7 与 ADR-13 / ADR-11 / ADR-10 / ADR-08 同口径，**重开需明确指出 ADR 给出的依据已被新证据推翻**。
5. **代码可减项**——P1-3（诊断口）、P2-7（`every` 必填 / `options` 不可替换 / `DeepReadonly` 撒谎）、P2-8（4 处 `as` 中 2 处可消除）、P2-10（`background` 撞名）；与 ADR 无强重叠，独立可推。
6. **§9 简化估值需重新实测**——ADR-12/14/15 实测同向改动减行数均小于评审估值，本评审 §9.4 的 −275 行在重新实测后预计为 −100 行左右。

### 10.4 本版校准记录（与历史版本的偏差）

| 项 | 上一版（v5 / ADR-13） | 本版（v6 实测） | 差异原因 |
|---|---|---|---|
| `src/` 行数 | 1755（v5）/ 1918（ADR-15） | 1770 | `delivery.ts` 头部增 `EFFECT_FAILED` 常量对象 |
| `src/manager.ts` | 639 / 640 | 640 | 行间空行 |
| `src/vue.ts` | 168 | 166 | 注释压缩 |
| `src/diagnostics.ts` | 58 | 55 | 注释压缩 |
| `src/delivery.ts` | 49 / 49 | **68** | 头部增 `EFFECT_FAILED`（+19 行；本评审 11 行偏移根因） |
| `Handle` 字段数 | 8（v5）/ 10（ADR-15） | **11**（4 固定端口 + 7 可变） | ADR-16 重写后增 `operationId` / `lifecycleActive` |
| `ConfigurationHost` 项数 | 3（ADR-11 / ADR-15） | **2** | ADR-18 RQ3 落地后由 3 缩为 2（`reconcile` + `requestFlush`） |
| `Manager.nextResourceId` 名 | `nextResourceId` | **`issuedResourceId`** | ADR-18 末段新增的"名不符实"勘误已落地 |
| `Resource.nextVersion` 名 | `nextVersion` | **`issuedVersion`** | 同上 |
| `tests/core.test.ts` | 1085 / 510（v5） | 1110 | ADR-16 重写后用例调整 |
| DESIGN §7.5 复核函数名 | 仅 5 个 | 实际 8 个 | DESIGN 漏 4 名（`currentOperation` / `present` / `allowed` / `currentWaiter`）、多 1 幻影名（`deliverable`）——**DESIGN 自身有 baseline drift** |
| ADR-15 自报 `Handle` | 10 字段 | 实测 11 字段 | **ADR 本身也会漂**（自标注过 10 处） |
| ADR-17 末段 `cancelRefresh` 改名 | 应已落地 | **manager.ts 无此函数** | ADR-17 改名前**未落地**——实际命名仍是 `releaseSubscription` / `settleRefreshes` |
| ADR-17 "`ConfigurationHost` 仍是 3 项" | 3 项 | **2 项** | 被 ADR-18 RQ3 推翻——ADR 内部冲突 |
| **新增未登记裁决** | — | **`LOAD_TIMEOUT_MS = 10_000` + `expireTask`**（`manager.ts:18, 394, 422-432`） | 注释说"2026-09-16 裁决"，但 ADR.md **没有 ADR-19 登记这次裁决**——**ADR.md 又一次 baseline drift** |
| 评审 §4 P0-1 初稿 | "框架缺超时需修补" | **框架已有 10 秒上限兜底** | **本评审的事实错误**：漏读了 `manager.ts:18/394/422` 与 U13/U20 |

> **基线漂移是已知现象**：[`ADR-13`](./ADR.md) 已记 v5 评测有 9 处与代码不符；[`ADR-15`](./ADR.md) 已记第十五版评审有 10 处与代码或公开仓库不符；本评审又命中同一种漂移模式（行数、字段数、复核函数名、`ConfigurationHost` 项数、命名落地与否、新增裁决未登记）。**校准应在每次评审前重做**，而不是依赖历史报告的引用。

### 10.5 一句话结论

本评审的 27 条初稿问题里：

- **1 条事实错误**（P0-1：漏读 `expireTask` / U13 / U20，"框架缺超时"立论作废）
- **1 条新增未登记裁决**（`LOAD_TIMEOUT_MS` 应作为 ADR-19）
- **10 条与 ADR / DESIGN / 统一文档无冲突、可独立推动**
- **2 条翻盘**（P2-9、P2-11，与 DESIGN §3.6 / §3.8 显式取舍冲突）
- **6 条与 ADR-11/12/13/14/15/17 已裁决的同源结构提案重叠**（重开需 ADR 未见过的证据）
- **10 条正面清单**（不构成问题）
- **1 条独立文档债务**（D-1）

**ADR 自身的判断不是全部准确**：

- **ADR-15**：自报 `Handle` 10 字段，实测 11（baseline drift 自带）
- **ADR-17**：自报"`cancelRefresh` 改名 + `ConfigurationHost` 仍是 3 项"，实测两处都不成立（前者改名前未落地，后者被 ADR-18 推翻）
- **ADR-13**：4 处硬反例中 1 处（`QueryHost`）前提已失效，但 ADR 自身已标注
- **ADR.md 已裁决清单**漏记 `LOAD_TIMEOUT_MS` 这次 2026-09-16 裁决

**§10 的可信度前提是评审与 ADR 都先校准**。本节以"ADR 是答辩"为前提，但答辩自身的可信度必须先与代码对照——这是本评审**反复踩进的同一个坑**（ADR-15 的 10 处漂移、ADR-13 的 9 处漂移、本版的 1 处 P0-1 漏读）。

---

## 附录 A · 关键代码位置索引（第 6 版实测，2026-09-16 校准）

| 主题 | 文件 | 行号 |
|---|---|---|
| `Manager` 类声明 | `src/manager.ts` | 41-640 |
| `ScheduleHost` 匿名实现 | `src/manager.ts` | 64-77 |
| `submit` → `commitDeclaration` | `src/manager.ts` | 111-152 |
| `refresh`（waiter 登记） | `src/manager.ts` | 169-194 |
| `synchronize` / `reconcile` | `src/manager.ts` | 212-235 |
| `releaseResourceIfUnused`（abort 唯一发出点） | `src/manager.ts` | 293-305 |
| `attach`（`submit` 后的异步交付点） | `src/manager.ts` | 311-327 |
| `enqueueTask` | `src/manager.ts` | 364-373 |
| `startTask`（`resource.task = null` 唯一位置） | `src/manager.ts` | 381-397 |
| `publishResult` | `src/manager.ts` | 405-420 |
| `collectReceivers`（Set 消重） | `src/manager.ts` | 423-445 |
| `publishError`（忽略 minVersion） | `src/manager.ts` | 458-472 |
| `refreshFloor`（launch 事实） | `src/manager.ts` | 502-506 |
| `refillWaiters` | `src/manager.ts` | 509-513 |
| 8 个复核函数 | `src/manager.ts` | 536-583 |
| `nextIdentity`（溢出即 dispose） | `src/manager.ts` | 589-596 |
| `Handle` 接口（11 字段：4 固定端口 + 7 可变） | `src/model.ts` | 84-107 |
| `Resource` / `Task` | `src/model.ts` | 110-132 |
| `Clock` 端口契约 | `src/model.ts` | 143-149 |
| `ConfigurationHost` / `ScheduleHost` | `src/model.ts` | 157-162, 181-192 |
| `RefreshWaiter` | `src/model.ts` | 71-76 |
| `flush` / `enqueueDue`（跳过有 task 的实例） | `src/scheduler.ts` | 89-98, 131-140 |
| `dueAt`（时钟只读一次） | `src/scheduler.ts` | 118-122 |
| `setWakeup` | `src/scheduler.ts` | 165-172 |
| `parameterKey` / `buildKey`（两趟全量遍历） | `src/source.ts` | 80-91 |
| `prepareParameters` | `src/source.ts` | 102-119 |
| `observe`（catch 丢弃 error） | `src/delivery.ts` | 46-52 |
| `notify` / `declarationIdentity` | `src/delivery.ts` | 58-68 |
| `reportObserverError` | `src/diagnostics.ts` | 26-39 |
| `observeRejection`（半暴露） | `src/diagnostics.ts` | 48-55 |
| `defineStore` 在函数内调用 | `src/store.ts` | 15, 39 |
| `bindings` WeakMap | `src/app.ts` | 27, 64-91 |
| 公共 `readSnapshot` | `src/app.ts` | 93-97 |
| `ErrorOrigin` / `CancelReason` 取值域 | `src/public-types.ts` | 38-46, 56-67 |
| 两个 `Exclude` 子集类型 | `src/public-types.ts` | 53, 73 |
| `RefreshError`（无 `operationId`） | `src/public-types.ts` | 94-97 |
| `SubmitResult` / `RefreshResult` | `src/public-types.ts` | 104-117 |
| `RefreshOptions`（对象不可替换） | `src/public-types.ts` | 138-153 |
| `readConfiguration`（三项独立捕错 + 部分快照） | `src/vue.ts` | 42-75 |
| `createConfigurationBinding`（`reported` 去重 + 代次复核） | `src/vue.ts` | 93-116 |
| `useRefresh` | `src/vue.ts` | 118-166 |

> 本报告所有结论基于静态阅读当前 `src/`（**1770 行**）。任何改动须在 `pnpm typecheck` + `pnpm test` + `pnpm check:docs` 三项闸门全绿的前提下进行。校准基线日期 **2026-09-16**——后续 PR 应重新校准本表。

---

## 附录 B · 全部问题总表（第 6 版）

> 严重度：**P0** = 正确性缺陷，必须修；**P1** = 应当修；**P2** = 建议修；**S** = 结构/设计问题；**D** = 文档债务；**R** = 已撤回/不构成问题。

| 编号 | 严重度 | 问题 | 位置 | 章节 | ADR/DESIGN 锚点 | 建议动作 |
|---|---|---|---|---|---|---|
| **P0-1** | **P0（**撤回**）** | 永不 settle 的 `load` 使实例永不再轮询、槽位永久泄漏、全应用静默停摆；`abort` 只在无订阅者时发 | `scheduler.ts:134`、`manager.ts:510, 301, 392, 304` | §4 | **本评审事实错误**：框架已有 10 秒上限兜底（`manager.ts:18` 的 `LOAD_TIMEOUT_MS` + 行 422 `expireTask`）；U13 已写入"框架上限到期作为兜底"；U20 写"框架另有一层上限（U13）作为兜底"。`统一刷新管理.md` §6.4.3 故障族清单的"5 个有限故障族"是评审初稿数错 | **撤回**（v6.1）；初稿立论"框架缺超时"作废。详见 §10 复核记录与 §4 P0-1 撤回声明 |
| P1-2 | P1 | `nextIdentity` 溢出即 `dispose()` 整个 Manager，且在调度热路径上 | `manager.ts:589-596`、`scheduler.ts:136` | §4 | [`ADR-12`](./ADR.md) 实测同类提案（改 `throw`）减行数 5 行（非 −12），且把 §2.4 契约改成同步抛错 | 删除；或只放弃分配、不销毁 Manager——重开需 ADR 未见过的证据 |
| P1-3 | P1 | 诊断通道丢弃原始 error，只打固定字符串 | `delivery.ts:49-51`、`diagnostics.ts:26-39` | §4, §7.3 | 无 ADR 关联（独立诊断口） | `reportObserverError` 接收 error，由框架决定输出内容 |
| P1-4 | P1 | `readSnapshot` 每次 O(参数规模) 两趟全量遍历；非 JSON 参数抛 `TypeError` 但签名未声明；不跑 `validate` | `app.ts:93-97`、`source.ts:80-91, 82` | §4 | `统一刷新管理.md` §4.2 / U17（不保证新鲜度）；§1 授权边界 | 改用调用方提供的稳定 id；统一两条入口的合法性判据 |
| P2-5 | P2 | `controller.abort()` 不在任何 `observe()` 内，"业务回调全隔离"不成立 | `manager.ts:304`、`public-types.ts:86` | §4 | `统一刷新管理.md` §3.5 U19 四类隔离通道 | 把 `abort()` 纳入隔离 |
| P2-6 | P2 | `publishError` 忽略 `minVersion`，`refresh()` 会被早于点击的请求失败结算 | `manager.ts:458-472, 502-506` | §4 | **[`DESIGN.md`](./DESIGN.md) §3.6 显式取舍**（不是 bug，是设计）；**翻盘**——评审若要立论需先论证 §3.6 错了 | 按 floor 过滤；或**先补文档**说明"refresh 的 floor 是启动后下限，不是成功下限" |
| P2-7 | P2 | `enabled`/`every` 强制必填（逼用户写假数字）；`options` 对象不可替换却无编译期拦截；`DeepReadonly` 运行时未冻结 | `public-types.ts:138-153, 143-145`、`delivery.ts:25-27` | §4 | `统一刷新管理.md` §2.1 / §2.2 / §3.6 U18；[`ADR-15`](./ADR.md) B1"runner 可选化"已实测 0 行 | `every` 允许省略；对 `options` 重建订阅或只收 `Ref`；要么冻要么改名 |
| P2-8 | P2 | 4 处 `as` 类型洗白，其中 2 处可消除 | `source.ts:43, 47`、`vue.ts:137`、`app.ts:96` | §4 | `统一刷新管理.md` §0 名词表（`RefreshSource` 品牌擦除是必要之恶） | `Manager` 泛型化 + 交付值冻结 |
| **P2-9** | **P2（翻盘）** | 两个 `Exclude` 子集类型，把"动作能产生哪些失败"藏在差集里 | `public-types.ts:53, 73` | §7.3 | **[`DESIGN.md`](./DESIGN.md) §3.8 明示 `Exclude` 是正确做法**——翻盘：评审若要立论需先论证 §3.8 错了 | 签名里写全可达子集（需 §3.8 重裁） |
| P2-10 | P2 | `'background'` 一个字面量在两个语义域复用（`display.origin` vs `error.origin`） | `public-types.ts:39-40` | §7.3 | `统一刷新管理.md` §0 名词表（共用字面量是约定） | 错误来源改名或与 `RequestOrigin` 解耦 |
| **P2-11** | **P2（翻盘）** | `RefreshError` 不带 `operationId`，多句柄页面的 `onError` 无法认领 | `public-types.ts:94-97` | §7.3 | **[`DESIGN.md`](./DESIGN.md) §3.8 明示"框架身份不进公开契约"是显式选择**——翻盘：与 [`ADR-04`](./ADR.md) `readSnapshot` 不交付时间同口径 | `RefreshError` 加入 `operationId`（需 §3.8 重裁） |
| P2-12 | P2 | `observeRejection` 单独导出但只被一处使用，覆盖关系需读两处 | `delivery.ts:46-52`、`diagnostics.ts:48-55`、`source.ts:113` | §7.3 | `DESIGN.md` §3.8 / `统一刷新管理.md` §6.4 | 统一走 `observe`，或在注释中点明覆盖关系 |
| **S-1** | S | `Handle` 是 11 字段（4 固定端口 + 7 可变）无守卫状态袋，跨模块直接读写；8 个复核函数是它的补丁 | `model.ts:84-107`、`vue.ts:134-146, 152`、`manager.ts:43, 536-583` | §1.2 | [`ADR-13`](./ADR.md) STATE-02/API-04（同类提案）已拒——"会新增 `Handle` 持久字段" | `Handle` 收进 `Manager` 作私有 class，`vue.ts` 只拿 sink——重开需 ADR 未见过的证据 |
| S-2 | S | `readSnapshot` 语义是"有活跃订阅时的窥视孔"，命名承诺了做不到的事 | `app.ts:93-97`、`manager.ts:293-305` | §1.3 | [`ADR-04`](./ADR.md) 已保留 `readSnapshot` 按"不保证新鲜度"交付 | 改名（如 `peekShared`）或补文档 |
| S-3 | S | `submit` 返回 `accepted` 但 `display` 要等下个微任务才有值，存在未定义窗口 | `manager.ts:150, 326` | §2 | `统一刷新管理.md` §2.1 / §2.5 / U16 | 同步 attach（并证明不可重入）或改 `async` |
| S-4 | S | `ScheduleHost` / `ConfigurationHost` 是只有一种实现的"端口"，实为绕开 ESM 环的类型体操 | `model.ts:157-162, 181-192`、`manager.ts:64-77` | §3.1 | [`ADR-11`](./ADR.md) / [`ADR-13`](./ADR.md) ARCH-11/ARCH-12/API-01/API-02 已关闭 | 合并；或让 `Scheduler` 持有窄引用——重开需 ADR 未见过的证据 |
| S-5 | S | `Manager` 仍承担 7 类职责 / 640 行 | `manager.ts:41-640` | §3.2 | `DESIGN.md` §1 / [`ADR-13`](./ADR.md) | **先做 S-1**，再拆 `Registry`/`Policy`/`Publisher` |
| S-6 | S | `bindings: WeakMap<App, ...>` 模块级全局状态与 `installedApp` 单次绑定互相打架 | `app.ts:27, 64-91, 65` | §3.3 | [`ADR-10`](./ADR.md) 安装矩阵（不删除"原地接管"） | 二选一：支持换 Manager，或删表 |
| S-7 | S | `defineStore` 在函数内调用（违反 Pinia 要求）；`delete pinia.state.value[id]` 依赖私有结构 | `store.ts:15, 39` | §3.3 | [`ADR-08`](./ADR.md) 私有 Pinia 分区不改为内存注册表 | 移到模块级；用公开 API 释放 |
| S-8 | S | `peerDependencies` 精确钉死 `vue@3.5.42` / `pinia@4.0.3` | `package.json:36-39` | §3.3 | `统一刷新管理.md` §6.2 禁止新增模块与架构层（变更需先裁决） | 放宽为范围 |
| D-1 | D | 配置暂态非法的场景（`Input` 三值语义、`reported` 去重、为何不首次同步抛错）未进 DESIGN | `vue.ts:42-75, 99-111`、DESIGN §3.8 附近 | §7.2, §7.5 | 无 ADR 关联（独立文档债务） | 补进 DESIGN，防止机制被误删 |
| R-1 | R | `readConfiguration` 三项独立 `try/catch` | `vue.ts:50-68` | §6.9 | 无 ADR 关联 | **不构成问题**：watcher 取值函数必须让三项各自完成依赖收集 |
| R-2 | R | 配置非法的电平快照 + 去重 + `configuration` 来源 | `vue.ts:45-74, 99-111`、`manager.ts:175` | §6.10, §7.2 | [`ADR-09`](./ADR.md) 配置降级不采纳（不把读不到猜成 `false`） | **不构成问题**：`enabled: computed(() => store.ready && ...)` 是合法暂态非法；只欠文档（D-1） |
| R-3 | R | 常量对象 + `keyof typeof` 推导取值域（不用 `TS enum`） | `public-types.ts:23-29` 等 | §6.3 | 无 ADR 关联 | **不构成问题**：手法正确（但见 P2-10） |
| R-4 | R | `RefreshWaiter` 用原生 Promise resolver，不做 settled 镜像 | `model.ts:71-76` | §6.4 | 无 ADR 关联 | **不构成问题** |
| R-5 | R | 派生值不存 + `collectReceivers` 用 `Set` 消重 | DESIGN §3.7、`manager.ts:423-445` | §6.5 | 无 ADR 关联 | **不构成问题** |
| R-6 | R | `MAX_TIMER_DELAY` 分段等待、`dueAt` 时钟只读一次 | `scheduler.ts:20, 167, 118-122` | §6.6 | 无 ADR 关联 | **不构成问题** |
| R-7 | R | `store.ts` 用 `shallowRef` 避免 Pinia 深代理破坏 `structuredClone` | `store.ts` | §6.7 | [`ADR-08`](./ADR.md) 私有 Pinia 分区 | **不构成问题** |
| R-8 | R | `index.ts` 逐个列出导出类型 | `index.ts` | §6.8 | 无 ADR 关联 | **不构成问题** |
| R-9 | R | `defineRefresh` 冻结对象 + 品牌字段只在类型层 | `source.ts:37-44` | §6.1 | 无 ADR 关联 | **不构成问题** |
| R-10 | R | `RefreshSource` 用 `args: (value: P) => P` 钉死不变型 | `public-types.ts:81-83` | §6.2 | 无 ADR 关联 | **不构成问题** |

**计数**：**P0 × 0（撤回 1）、P1 × 3、P2 × 8（含 2 项翻盘）、S × 8、D × 1**；已撤回/正面清单 R × 10。P0-1 撤回声明见 §4，详见 §10.5 一句话结论。

**修复顺序建议**（仅对**未翻盘、未与已裁决 ADR 重叠、未撤回**的条目适用）：

1. **D-1**（纯文档，零风险，但防止 §7.2 的 40 行机制被误删）；
2. **ADR-19 登记 + DESIGN §5.2 注释更新**（`LOAD_TIMEOUT_MS` 这次 2026-09-16 裁决）；如 §6.4.3 故障族清单未更新"框架上限到期"应同步补——独立可推；
3. **P2-9** / **P2-11**（翻盘项）→ 需先推动 [`DESIGN.md`](./DESIGN.md) §3.6 / §3.8 重裁，不是单纯实施；
4. **S-1** / **S-4** / **S-5** / **S-6** / **S-7**（结构级提案）→ **与 ADR-13 / ADR-11 / ADR-08 / ADR-10 同源**，重开需提供 ADR 未见过的证据；
5. **P1-2** / **P1-3** → 前者 ADR-12 已实测 −5 行（不是 −12），后者独立诊断口；
6. 其余。

**翻盘与已裁决提示**：**P2-9**、**P2-11** 与 [`DESIGN.md`](./DESIGN.md) §3.6 / §3.8 显式取舍冲突——这 2 项不应当作 bug 实施，需先推动文档裁决。**P0-1 已撤回**（v6.1），详见 §4 撤回声明与 §10 复核记录。
