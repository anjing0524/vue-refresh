# vue-refresh 代码审查报告（第 5 版 · 简化与可读性专项）

- 审查对象：`src/`（11 个 TS 源文件，约 1920 行）、`scripts/`（4 个校验脚本）、`tests/`（7 个测试文件）
- 文档基线：`统一刷新管理.md`、`DESIGN.md`（行为契约与设计意图的唯一来源）
- 立场：**对坏味道零容忍**；本版不重写契约，只梳理结构、压低复杂度、缩短调用链路
- 与上版（v4）关系：v4 已关闭 P0 与多数 P1，本版聚焦**结构简化与可读性**——`manager.ts` 642 行 / 34 个方法 / 56 个 `if` 是剩余债的核心

> **一句话结论（第 5 版）**：`manager.ts` 既是当前架构的"中心真理"，也是复杂度、阅读成本与未来变更风险的唯一瓶颈。它在**结构层面**已经合格（八个分段、命名操作面、`inspect()` 只读投影、依赖单向），但在**职责密度**与**状态字段数**上仍处于"再分一块就崩溃"的边缘。本版给出三步走的明确拆分与简化路径，可在不引入新概念、不破坏既有契约的前提下把核心复杂度再压低一档。

---

## 0. 度量基线（v5 实测）

### 0.1 文件与复杂度

| 文件 | 行数 | `if (` 数 | 公开方法 | 私有方法 | 备注 |
|---|---|---|---|---|---|
| `src/manager.ts` | 642 | 56 | 12 | 16 | **占总行 33% / 总分支 51%** |
| `src/model.ts` | 256 | 0（仅类型） | — | — | 8 个 interface + 3 个端口 |
| `src/vue.ts` | 177 | 10 | 1 | 0 | `useRefresh` 84 行 |
| `src/scheduler.ts` | 170 | 8 | 5 | 7 | `Scheduler` 类 |
| `src/public-types.ts` | 189 | 0 | — | — | 公共类型 |
| `src/source.ts` | 119 | 4 | 2 | 1 | `defineRefresh` / `prepareParameters` |
| `src/app.ts` | 101 | 7 | 1 | 0 | `createRefreshManager` |
| `src/query.ts` | 103 | 2 | 4 | 0 | `executeQuery` / `failQuery` 等 |
| `src/diagnostics.ts` | 58 | 0 | 2 | 0 | 诊断叶子 |
| `src/store.ts` | 42 | 0 | 0 | 0 | Pinia 适配 |
| `src/index.ts` | 14 | 0 | — | — | 入口 |
| **合计** | **1920** | **94** | **26** | **24** | — |

### 0.2 集中度风险

- `manager.ts` 一个文件 = **33% 行数 + 51% 分支**；任何一个修改都要进入该文件，扩散半径过大
- `Manager` 类聚合了**五类职责**（状态观测、页面操作、需求关系、后台执行、有效性与身份 + 释放 + 提交要求 = 八个分段），这是上版 `MOD-01` 标定的真实债
- `Handle` 持有 8 个可变字段（`cleanup` / `operationId` / `submission` / `activity` / `lifecycleActive` / `disposed` + 两个固定端口），其中 5 个由不同代码路径异步写入，**没有统一的"状态机迁移"函数**

### 0.3 测试规模

- `tests/core.test.ts` 510 行 / `tests/vue.test.ts` 298 行 = **测试代码约为生产代码的 42%**，密度合理
- `tests/scenarios.ts` 137 行做场景抽象；fixture 25 行；浏览器测试 43 行——基础设施已到位
- 风险点：测试侧依赖 `inspect()` 的内部事实断言（v4 整改后），如果 `manager.ts` 拆分，会要求测试观测面同步迁移；本报告在 §8 给出兼容方案

---

## 1. 维度一 · 架构设计

### 1.1 现状（已合格部分）

```
public-types.ts   diagnostics.ts       (L0 · 零依赖叶子)
        ↑                ↑
model.ts  source.ts  delivery.ts        (L1 · 业务边界)
        ↑                ↑
query.ts  store.ts  scheduler.ts        (L2 · 执行路径)
        └──────┬─────────┘
             manager.ts                   (L3 · 编排层)
                ↑
        app.ts ← vue.ts                   (L4 · 适配层，vue→app 为承认边)
                ↑
              index.ts                    (L5 · 门面)
```

依赖方向严格单向，承认边有闸门验证。**架构骨架是合格的**，本版不再质疑方向。

### 1.2 问题清单

| ID | 严重度 | 位置 | 问题描述 | 改进方向 |
|---|---|---|---|---|
| **ARCH-10** | **P1** | `manager.ts` 整体 | **单一上帝类**：五类职责共存于一个 642 行的 `Manager` 类，私有方法 16 个，命名操作 12 个；任何改动都要进入该文件，未来维护者必然"望而生畏" | **拆分为 4 个内部协作者类**（见 §1.3 蓝图），由 `Manager` 作为门面聚合 |
| **ARCH-11** | **P2** | `model.ts:223-234` `ScheduleHost` | **回调粒度过细**：5 个回调（`isDisposed` / `reconcileHandles` / `enqueueTask` / `isCurrentTask` / `startTask`）反映的是"调度器需要问编排层的 5 件事"，但回调之间没有内聚——`enqueueTask` 后立刻要 `isCurrentTask`，`startTask` 后立刻要 `isCurrentTask`，可压缩为"任务生命周期事件" | 合并为 `enqueue(task)` + `execute(task)` 两个动作 + 一个 `isDisposed()`；`isCurrentTask` 由编排层在闭包内提供 |
| **ARCH-12** | **P2** | `manager.ts:67-80` | **构造函数内联匿名对象作为端口实现**：可读但与 `ScheduleHost` 接口的"窄端口"承诺不一致——一个 18 行的对象字面量实现一个 5 方法接口，且其中 `reconcileHandles` 又调用本类私有方法 | 抽 `HostAdapter implements ScheduleHost`（约 20 行）放独立文件 `host.ts`，让 `manager.ts` 不再持有回调的形状知识 |
| **ARCH-13** | **P3** | `app.ts:34-42` `createNamespace` | 三段回退的 UUID 实现，与 `app.ts` 的"应用边界"职责不直接相关；属于工具函数 | 提取到 `namespace.ts`，与 `crypto` 平台探测解耦 |

### 1.3 `manager.ts` 拆分蓝图

按"职责而非方法数"拆分，目标：**每个内部类 ≤ 150 行、≤ 12 个方法、单 `if (` ≤ 10**：

```
Manager (门面，约 80 行)
  ├─ HandleRegistry         (handles / addHandle / removeHandle / inspect handles)
  ├─ ResourceRegistry       (resources / resourceFor / releaseSubscription / inspect resources)
  ├─ OperationEngine        (submit / query / beginOperation / setSubmission / setRequirement)
  ├─ SubscriptionEngine    (synchronize / attach / enqueueTask / startTask / publishResult / publishError / deliver)
  ├─ EligibilityChecker     (eligible / allowed / present / refused / registered / currentTask / currentSubscription / deliverable / nextIdentity)
  └─ Scheduler (已存在)
```

合并后的接口面（仅暴露给适配层和测试）：
- `addHandle / removeHandle / activate / deactivate / setBrowserVisible / setCleanup / setHandleCleanup / closeQuery / reconcile / submit / query / readSnapshot / dispose / inspect / isDisposed`（15 个，比现在的 18 个减 3 个）

可立即释放的方法（合并/删除候选）：
- `requestFlush()` → 内部 `Scheduler.requestFlush()` 通过 `EligibilityChecker.requestFlush()` 委托，外部仍可见
- `forgetActivity()` → 并入 `OperationEngine.releaseActivity` 内部

### 1.4 拆分收益评估

| 指标 | 当前 | 拆分后 | 改善 |
|---|---|---|---|
| `manager.ts` 行数 | 642 | ≤ 80（门面）+ 6 × 平均 100 | **核心阅读量 -87%** |
| `if (` 集中度 | 56 (51%) | 每文件 ≤ 10 | **最坏函数 CCN 估算从 ~12 降至 ≤ 5** |
| 命名操作总数 | 18 | 15 | 公共面收紧 |
| 适配层修改半径 | 每次都可能触碰整个类 | 按职责分散到对应协作者 | 风险半径 -60% |

**拆分代价**：新增 5 个文件、`EligibilityChecker` 与 `OperationEngine` 之间出现双向调用（需端口化）、测试断言 `inspect()` 的形状不变但实现细节改变。本版把"测试兼容"作为硬约束写进 §8。

---

## 2. 维度二 · 模块划分

### 2.1 现状评估

v4 已确认 `diagnostics.ts` 是 L0 叶子，`vue.ts → app.ts` 是被承认的等层边，**模块分层合格**。本版只补三条**粒度问题**。

### 2.2 问题清单

| ID | 严重度 | 位置 | 问题描述 | 改进方向 |
|---|---|---|---|---|
| **MOD-02** | **P2** | `model.ts` 整体 | **端口与领域模型混居**：`Handle` / `Resource` / `Task` / `Clock`（领域事实）与 `QueryHost` / `ConfigurationHost` / `ScheduleHost` / `ManagerInspection`（协作端口）写在同一文件；端口变更时会污染领域类型，领域类型变更时也会影响端口契约 | 拆为 `model-domain.ts`（仅领域类型）+ `model-ports.ts`（仅端口）；`public-types.ts` 不动 |
| **MOD-03** | **P2** | `vue.ts:93-124` `createConfigurationBinding` | **42 行的闭包工厂**：`watch` 回调 + 边沿检测 + 通知去重 + 操作号复核全部塞进一个闭包；变量状态在外部捕获（`lastEnabled` / `reported`），作用域靠闭包维持，可读性低于等价的 `class` | 重写为 `class ConfigurationBinding implements { watch(): WatchStopHandle }`；显式字段、显式方法，单一职责 |
| **MOD-04** | **P3** | `scheduler.ts:115-119` `dueAt` | **隐式约定**：循环里现算最小间隔并写在 `Scheduler` 私有方法内——这个不变量是 U11 的实现点，但只在 `Scheduler.dueAt` 一处维护，外部没有任何端口引用它 | 在 `model.ts` 加 `effectiveInterval(resource): number` 作为"派生值"的唯一入口，让 `dueAt` 与未来的 `flush()` 重构共享这一行 |

### 2.3 模块边界优化清单（不破层）

| 操作 | 收益 |
|---|---|
| 把 `prepareParameters` 的 `ASYNC_VALIDATE` 提示搬到 `source.ts` 的常量旁（已就位） | 无需移动 |
| 把 `model.ts` 的 `Clock` 移到 `scheduler.ts` 同目录的新文件 `clock.ts` | 让 `Scheduler` 不需要跨文件读 `Clock` 端口类型 |
| 把 `query.ts` 的 `commit` 抛错文案迁回 `public-types.ts` 注释（已就位） | 无需移动 |
| 把 `manager.ts` 的 `beginOperation` 拆为独立的 `OperationStateMachine`（私有类） | 让 `Handle.submission` / `Handle.activity` / `Handle.operationId` 的"先建新身份再释放旧活动"不变量只活在一个地方 |

---

## 3. 维度三 · 数据流管理

### 3.1 现状梳理

| 数据流 | 起点 | 终点 | 中间环节 |
|---|---|---|---|
| **页面提交** | `useRefresh.submit(args)` | `Submission` 落 `Handle.submission` | `prepareParameters` → 校验 → `Manager.submit` → `beginOperation` → `setSubmission` |
| **后台执行** | `Scheduler.startTask` | `StoreEntry` + `Handle.publish` | `load` → `copyResult` → `publishResult` → `deliver` → `observe(publish)` |
| **主动查询** | `useRefresh.query(args, runner)` | `QueryResult` Promise + `Handle.publish` | `Manager.query` → `executeQuery` → `commit` 闭包 |
| **配置变化** | `watch(() => readConfiguration(...))` | `Input` 快照 + `reconcile` | `synchronize` → `attach` |
| **生命周期** | `onMounted` / `onDeactivated` | `reconcile` | `activate` / `deactivate` |

### 3.2 问题清单

| ID | 严重度 | 位置 | 问题描述 | 改进方向 |
|---|---|---|---|---|
| **FLOW-02** | **P1** | `manager.ts:307-309, 288-298, 312-315` | **"释放活动"逻辑分裂**：`releaseActivity` / `forgetActivity` / `releaseQuery` / `releaseSubscription` 四个方法共同完成"取消一个活动"，但调用方要在 `beginOperation` / `removeHandle` / `closeQuery` / `synchronize` 之间反复选——形成"释放路径有 4 条入口 + 3 种语义（superseded / unavailable / disposed）" | 收敛为单个 `releaseActivity(handle, activity, reason)`，要求调用方**显式给出活动引用与原因**；`forgetActivity` 退化为 `releaseActivity` 的特例（reason=`null` 表示仅登记清除） |
| **FLOW-03** | **P1** | `manager.ts:149-153, 504-507, 515-517, 519-522` | **环境允许多谓词 + 配置非法多分支**：`admitQuery` 判 `valid` → `allowed` 判 `present && visible===true` → `refused` 判 `visible===false` → `eligible` 又重新判一遍；同一个语义被三处独立维护 | 引入**单点决策**：`admit(handle, input)` 返回 `{ allow: true } \| { deny: DenyReason }`；所有入口（`query` 入口闸、`synchronize`、`attach`、`deliver`）都消费这个决策，不再各自内联 |
| **FLOW-04** | **P2** | `manager.ts:439-455` `publishResult` + `458-469` `publishError` + `472-483` `deliver` | **三处反复"复核身份 + 逐订阅 deliver"**：`publishResult` 现算 `deliveries` 数组后逐项调用 `deliver`，`publishError` 内联遍历并直接 `notify`，`deliver` 又再做一次 `currentSubscription` 复核——三处读 `resource.subscribers` 的快照方式不一致（`for ... of` 与 `[...arr]`） | 把"逐订阅分发"收敛为单一 `dispatch(subscribers, fn)`，`publishResult` 与 `publishError` 都通过它；`deliver` 内不再复核（由调用方保证快照） |
| **FLOW-05** | **P2** | `manager.ts:139, 184` | **`requestDelivery()` 与 `owesRequest()` 形成"两词一义"对偶**：前者构造 `{ barrier: null }`，后者判 `delivery !== null && delivery.barrier === null`——任何一处的措辞变化都会让另一处失配 | 把 `Delivery` 简化为三态代数（见 §5.3）；`{ barrier: null }` 这个值不再需要 |
| **FLOW-06** | **P3** | `manager.ts:255-259` `setBrowserVisible` | **遍历顺序与 reconcile 重复**：先 `for (handle of handles) synchronize`，再 `requestFlush`——`flush` 内部又会调 `reconcileHandles` 走第二遍同步；两次同步幂等，但**含义混淆**：第一遍是"立即结算在途查询"，第二遍是"重新进入资格" | 把 `setBrowserVisible` 改成 `manager.setBrowserVisible(false)` 路径下**仅同步独立查询**，`true` 路径下**只 flush**——理由（隐藏/恢复）写进两个分支 |
| **FLOW-07** | **P3** | `manager.ts:564-571` `nextIdentity` | **副作用耦合**：`nextIdentity` 在耗尽时调用 `this.dispose()` 并写 observer 诊断——一个"取下一个序号"的纯函数混进了 Manager 生命周期 | 把耗尽处理提到调用方（`enqueueTask` / `submit` / `query` / `resourceFor`），`nextIdentity` 变为**纯函数** `nextId(prev): number | null`；耗尽 = `dispose` + 日志由调用方负责 |

---

## 4. 维度四 · 组件复用 / 模式识别

### 4.1 已抽取但仍可压缩的模式

| 模式 | 当前形式 | 复用位置 | 压缩建议 |
|---|---|---|---|
| **observe**（try/catch + 异步观察） | `delivery.ts:35-41` + `diagnostics.ts:51-58` | `manager.ts:329, 448, 477, 482, 592, 609, 613` 等 7 处 | **保持现状**（已是最简）；唯一改进：`observe(callback)` 直接接 `() => unknown`，省掉 identity 参数的 `{}` 默认值 |
| **identity check**（判当前身份是否仍有效） | `query.ts:22-24` `currentOperation` + `query.ts:27-29` `currentQuery` + `manager.ts:530-532` `currentTask` + `manager.ts:535-540` `currentSubscription` | 11 处调用 | **统一为 `isCurrent(entity)`**，用 entity 类型做窄判别；4 个谓词合成 1 个（见 §4.2） |
| **counter overflow → dispose** | `manager.ts:564-571` `nextIdentity` 内部 `this.dispose()` | 3 个调用点 | **提到调用方**（见 FLOW-07） |
| **submission 写入** | `manager.ts:631-633` `setSubmission` + `639-641` `setRequirement` | 5 个调用点 | **合并为 `setDelivery(handle, submission, delivery)`**，把 parameters 与 delivery 的写入收敛到一处 |
| **releaseActivity 默认参数** | `manager.ts:288-292` `captured = handle.activity, reason = Superseded` | 4 个调用点 | **去默认**：要求所有调用方显式给出 `(handle, captured, reason)`，消除"为何默认 superseded"的歧义 |
| **nextIdentity 三处分别维护** | `manager.ts:117` `handle.operationId` / `375` `this.nextResourceId` / `401` `resource.nextVersion` | — | **抽 `Counter` 私有类**（3 行实现），三个实例共享同一份耗尽行为 |

### 4.2 建议新增的统一身份检查

```ts
// 当前 4 个谓词
currentOperation(owner, handle, id): boolean
currentQuery(owner, handle, run): boolean
currentTask(task): boolean
currentSubscription(subscription): boolean

// 建议
function isCurrent(entity: Handle | QueryRun | Task | Subscription): boolean {
  switch (entity.kind) { /* 4 个 case */ }
}
```

收益：
- **11 处调用 → 1 处定义**，新增/修改只需改 1 个函数
- 消除 `currentOperation` 与 `currentQuery` 的"几乎相同"重复（只差一个字段检查）
- `isCurrent` 在 `EligibilityChecker` 内部，与 §1.3 拆分蓝图一致

### 4.3 `Handle` 字段归并

当前 `Handle` 有 8 个字段，其中：

| 字段 | 写入方 | 频次 |
|---|---|---|
| `cleanup` | `setHandleCleanup` | 1 次 |
| `operationId` | `beginOperation` | N 次（每次提交/查询） |
| `submission` | `setSubmission` / `removeHandle` | N 次 |
| `activity` | `beginOperation` / `forgetActivity` / `attach` / `removeHandle` | N 次 |
| `lifecycleActive` | `activate` / `deactivate` | 偶发 |
| `disposed` | `removeHandle` | 1 次 |

**所有可变字段的写入都由 Manager 独占**——这条性质已经在 v4 落实。但 5 个"频繁写入字段"被分散到 3 个方法（`beginOperation` / `setSubmission` / `forgetActivity`），**没有任何方法保证"先建新身份再清旧活动"的原子性**。

**改进方向**：把 `beginOperation` / `setSubmission` / `setRequirement` / `forgetActivity` 合并为单一状态机迁移函数：

```ts
class OperationStateMachine {
  transition(handle: Handle, action: Action): void
}

type Action =
  | { type: 'begin', id: number, activity: Activity | null }
  | { type: 'record', parameters: Parameters, delivery: Delivery }
  | { type: 'require', submission: Submission, delivery: Delivery }
  | { type: 'forget', activity: Activity }
  | { type: 'dispose' }
```

收益：
- **5 字段写入集中到 1 个 reducer**，所有"先 X 再 Y"的顺序保证只活在一个 switch 内
- 测试可独立验证状态机（无需启动 Manager）
- 调试时可打印 `handle.submission` / `handle.activity` / `handle.operationId` 之外的事件日志

代价：
- 引入"动作"类型（5 个分支）
- `setSubmission` / `setRequirement` 的直接调用点（5 处）改为构造 Action

---

## 5. 维度五 · 状态管理 / 数据模型

### 5.1 现状

| 类型 | 字段数 | 可变字段 | 写入者 |
|---|---|---|---|
| `Handle` | 8 | 6 | Manager（独占）✓ |
| `Submission` | 2 | 1（`delivery`） | Manager（独占）✓ |
| `Resource` | 7 | 4 | Manager（独占）✓ |
| `Task` | 3 | 0 | Manager（独占）✓ |
| `Delivery` | 1（嵌套） | 整体 | Manager（独占）✓ |
| `Subscription` | 4 | 1（`every`） | Manager（独占）✓ |

**唯一所有者"在编译期成立"——v4 已落实**。本版只针对字段语义、字段数量、表达效率做压缩。

### 5.2 问题清单

| ID | 严重度 | 位置 | 问题描述 | 改进方向 |
|---|---|---|---|---|
| **STATE-01** | **P1** | `model.ts:91-103` | **`Delivery` 三态用嵌套 null 表达**：`null`（无要求）/ `{ barrier: null }`（尚欠请求）/ `{ barrier: { resourceId, minVersion } }`（已登记）——`null` 同时是"无要求"和"尚欠"的语义，调用方必须记两个 null | 展开为 discriminated union：<br>`type Delivery = null \| { pending: true } \| { barrier: DeliveryBarrier }`<br>（不再有嵌套 `barrier: null`）|
| **STATE-02** | **P2** | `model.ts:106-109` `Submission` | **`parameters` readonly + `delivery` mutable** 的非对称 mutability 暗示"参数不可改、要求可改"，但实际调用点都整体替换 Submission | `Submission` 改为 `readonly` 全字段；如需更新 delivery，`setRequirement` 改为**返回新 Submission 对象**（immutable update）|
| **STATE-03** | **P2** | `model.ts:136-149` `Resource` | **7 个字段同时持有"身份 + 关系 + 进度 + 任务"**：阅读 `Resource` 时要在四类信息间切换 | 拆为内部组合：`{ identity, schedule, task }` 三个内部接口；外部仍然只看到一个 `Resource`，但 `EligibilityChecker` 只读 `schedule` |
| **STATE-04** | **P3** | `model.ts:59-63` `ActivityKind` | **只有 2 个值**：`Query` 与 `Subscription`；判别用 `kind` 字段 + 类型守卫 | 可省——直接 `handle.activity instanceof QueryRun`（运行时区分）；类型层面保留 `kind`（用于序列化与日志） |

### 5.3 `Delivery` 简化对照

```ts
// 当前
type Delivery = DeliveryRequest | null
interface DeliveryRequest { readonly barrier: DeliveryBarrier | null }
// null = 无要求
// { barrier: null } = 尚欠请求（未登记资源）
// { barrier: { resourceId, minVersion } } = 等待具体版本

// 建议
type Delivery = null | { pending: true } | { barrier: DeliveryBarrier }
type PendingDelivery = { pending: true }
type BarrierDelivery = { barrier: DeliveryBarrier }

// 判别
function isPending(d: Delivery): d is PendingDelivery { return d !== null && 'pending' in d }
function isBarrier(d: Delivery): d is BarrierDelivery { return d !== null && 'barrier' in d }
```

收益：
- 消除"两个 null"的歧义：`null` 永远表示"无要求"
- 类型判别从"双重字段存在性"变成"单字段存在性"
- `owesRequest(d)` 退化为 `isPending(d)`

代价：
- `requestDelivery()` 返回 `{ pending: true }`（更明确）
- `enqueueTask` 中的 `setRequirement(submission, { barrier: { resourceId, minVersion } })` 不变

---

## 6. 维度六 · 接口设计

### 6.1 现状评估

| 接口 | 文件 | 方法数 | 调用方 | 评估 |
|---|---|---|---|---|
| `QueryHost` | `model.ts:181-189` | 4 | `query.ts` | 合格——只暴露必要事实 |
| `ConfigurationHost` | `model.ts:197-204` | 3 | `vue.ts` | 合格 |
| `ScheduleHost` | `model.ts:223-234` | 5 | `scheduler.ts` | **过度细化**（见 ARCH-11）|
| `ScheduleInspection` | `model.ts:207-214` | — | `inspect()` | 合格 |
| `ManagerInspection` | `model.ts:243-256` | — | 测试 | 合格 |
| `ResultStore` | `model.ts:26-31` | 3 | `manager.ts` | 合格 |
| `Clock` | `model.ts:167-173` | 3 | `app.ts` / `manager.ts` | 合格 |

**接口数量与粒度整体合格**。本版补三条局部问题。

### 6.2 问题清单

| ID | 严重度 | 位置 | 问题描述 | 改进方向 |
|---|---|---|---|---|
| **API-01** | **P2** | `model.ts:181-204` | **`QueryHost` 与 `ConfigurationHost` 重叠**：`isDisposed()` 与 `requestFlush()` 都出现在两者中（实际 `ConfigurationHost` 缺 `isDisposed`，但通过 `manager.isDisposed()` 间接调用） | 合并为单个 `HostPort { isDisposed, requestFlush }`；`QueryHost extends HostPort { clock, forgetActivity }`；`ConfigurationHost extends HostPort { closeQuery, reconcile }` |
| **API-02** | **P2** | `manager.ts:67-80` | **匿名对象实现 `ScheduleHost`**：18 行对象字面量 + 箭头函数捕获 `this`，无法独立测试 | 抽 `class HostAdapter implements ScheduleHost`（与 §1.3 `EligibilityChecker` 同模块），构造函数注入 `Manager` 引用 |
| **API-03** | **P3** | `manager.ts:488-490` `requestFlush()` | **公共面只为了"被测试与被 `closeQuery`/`reconcile` 间接调用"**：暴露外部反而扩大公共面 | `requestFlush` 改回 `private`，由 `inspect()` 的 `pendingFlush` 间接观测 |
| **API-04** | **P3** | `model.ts:107-109` | **`Submission` 接口同时承担"参数容器 + 交付要求"两个语义** | `submission: { parameters: Parameters }` + `delivery: Delivery \| null`（外提）——把 delivery 从 submission 里拆出来；判别与写入路径同步简化 |

### 6.3 命名空间与导入简化

- `app.ts` 直接 `import { Manager } from './manager.ts'`，建议改为**只导入需要的成员**，减少跨文件耦合：但当前 5 个导入点都是 `Manager` 类的不同方法，导入粒度已经最细
- `vue.ts` 同时导入 `managerKey`、`notify`、`prepareParameters`、`sourceRuntime`——其中 `notify` 是为了配置 watcher 的 `ErrorOrigin.Configuration` 通知；这个导入链可以在 `vue.ts` 内部直接构造通知对象（不需要绕道 `delivery.notify`），减少一处跨模块跳转
- `query.ts` 的 `import { ErrorOrigin, RequestOrigin } from './public-types.ts'` 与 `import type { QueryErrorOrigin, ... }` 分两行——可合并为单行 `import { ErrorOrigin, RequestOrigin } from './public-types.ts'` + `import type`（已有，可省）

---

## 7. 维度七 · 可维护性

### 7.1 阅读成本

| 阅读任务 | 当前所需文件 | 阅读行数 |
|---|---|---|
| 理解"提交一条请求到收到结果"的完整路径 | `vue.ts` + `manager.ts` + `query.ts` + `delivery.ts` + `scheduler.ts` + `model.ts` | ~1100 行 |
| 理解"资格（U25）的判定" | `manager.ts:504-522` + `model.ts:34-52` | ~30 行 ✓ |
| 理解"交付门槛的写入与消费" | `manager.ts:631-641, 411-412, 476, 549-558` | 散落 4 处 |
| 理解"取消结算的 4 条路径" | `manager.ts:288-298, 312-315, 318-331` + `query.ts:38-51` | 4 个文件 |
| 理解"独立查询 vs 后台订阅的分支判定" | `manager.ts:206-213, 339-340, 549-558` | 散落 3 处 |

**3 个阅读任务跨越 ≥ 4 处代码位置**——可读性的主要瓶颈。

### 7.2 问题清单

| ID | 严重度 | 位置 | 问题描述 | 改进方向 |
|---|---|---|---|---|
| **MAINT-05** | **P1** | `manager.ts:288-298` + `query.ts:38-51` | **"结算 + 解活动 + 通知 + 调度" 四件套在 3 处复制**：`failQuery` 一遍、`executeQuery` success 一遍、`releaseQuery` 一遍 | 收敛为单个 `settleAndCleanup(handle, run, outcome)`，把"是否通知"与"如何结算"参数化（见 §7.3）|
| **MAINT-06** | **P2** | `manager.ts:206-220` `synchronize` | **单方法承载 3 个分支**（独立查询 / 取消资格 / 改频率），每个分支都需要不同原因——但函数名只是"synchronize"，3 个语义合并在一个名字下 | 拆为 `synchronizeSubscription(handle, captured, input)` + `synchronizeQuery(handle, captured, input)`；公共面只剩 `synchronize(handle)` 转发 |
| **MAINT-07** | **P2** | `manager.ts:337-363` `attach` | **4 个早返回 + 2 个条件交付 + 1 个隐式 enqueue**——一个函数 27 行承载 Resource 创建、Subscription 建立、barrier 处理、entry 交付 | 拆为 `tryAttach(handle): Subscription \| null`（建立关系）+ `applyDelivery(subscription, submission)`（处理 barrier 与 entry）|
| **MAINT-08** | **P2** | `manager.ts:439-455` `publishResult` | **先收集 deliveries 数组再逐项 deliver**——但 `currentTask(task)` 复核出现在循环内每次 deliver 之前，等价于"每个订阅重判一次"，而 `deliver` 内部又重判一次 | 一次 `deliverable` 复核 + 一次 deliver 即可；`currentTask` 复核放在循环顶部 |
| **MAINT-09** | **P3** | `manager.ts` 头部注释 §3 | **段落注释占 40+ 行**：每段方法前的 `// ═══ 后台执行 ═══` 注释把方法职责写在调用方可见处，但**与代码本身的命名已经能体现** | 段落注释精简为 1 行指引（"§1.3 拆分后由 `SubscriptionEngine` 持有"），详细信息移到对应类的顶部 |
| **MAINT-10** | **P3** | `model.ts` 全部接口 | **JSDoc 注释与 DESIGN.md 重复**：`Handle` / `Resource` / `Task` 三个核心接口的字段注释几乎逐字对应 DESIGN §3.3 表格 | 字段注释精简为"类型 + 写入者指针（指向 §3.3 段落号）"——避免双源真相 |

### 7.3 "结算"模板（建议）

```ts
// 当前：3 处复制
function failQuery(...): void { /* settle → forgetActivity → notify → requestFlush */ }
function executeQuery(...): Promise<void> { /* ... if success: observe(publish) → settle → forgetActivity → requestFlush */ }
function releaseQuery(...): void { /* settle(cancelled) → abort */ }

// 建议：1 个函数
function settle(
  handle: Handle,
  outcome: QueryResult,
  options: { notify?: RefreshError, abort?: AbortController },
): void {
  // settle → (notify if needed) → forgetActivity → requestFlush if not cancelled
}
```

---

## 8. 测试与可观测性（拆分兼容方案）

### 8.1 测试现状

- `tests/core.test.ts` 510 行（核心行为）
- `tests/vue.test.ts` 298 行（Vue 集成）
- 两者都通过 `inspect()` 读取内部事实，**这是 v4 整改的成果**，本版**继续保留**

### 8.2 拆分兼容要求

按 §1.3 拆分后，`Manager.inspect()` 的形状**保持不变**：

```ts
// 不变
interface ManagerInspection {
  disposed, visible, pendingFlush, scheduled,
  handles: readonly Handle[],
  resources: readonly Resource[],
  queued: readonly Task[],
  running: readonly Task[],
  entries: Readonly<Partial<Record<string, StoreEntry>>>,
}
```

`EligibilityChecker` / `OperationEngine` 等**内部**类不增加新的公共接口；`inspect()` 由门面 `Manager` 聚合输出。

### 8.3 测试补充建议（不破契约）

| 测试主题 | 缺失项 | 补充价值 |
|---|---|---|
| 状态机迁移 | `OperationStateMachine` 独立单元测试 | 拆分后必须新增 |
| 资格判定 | `EligibilityChecker` 在每组事实下的真值表 | 拆分后必须新增 |
| Delivery 三态 | `STATE-01` 简化后必须有专门覆盖 | 替换旧 `{ barrier: null }` 字面量 |
| `isCurrent` 统一判别 | 4 种 entity 各跑一遍 | 替换 4 个旧谓词的覆盖 |

---

## 9. 优先级路线图（按 ROI 排序）

### 第一波 · 低风险高收益（1 周内可完成，不破契约）

| 步骤 | 涉及 ID | 行数变化 | 测试改动 |
|---|---|---|---|
| ① 抽 `nextId` 纯函数（FLOW-07） | 3 调用点 | -8 | 0 |
| ② 合并 `setSubmission` / `setRequirement` / `beginOperation` / `forgetActivity` 为 `OperationStateMachine`（MAINT-10） | 4 方法 → 1 reducer | -25 | +30 |
| ③ `Delivery` 简化为三态代数（STATE-01） | 1 类型 + 1 谓词 | -5 | +15 |
| ④ 合并 `QueryHost` / `ConfigurationHost` 为 `HostPort`（API-01） | 2 接口 → 1 + 2 子型 | -10 | 0 |
| ⑤ 4 个 `current*` 谓词合并为 `isCurrent`（§4.2） | 4 函数 → 1 | -30 | +20 |
| ⑥ `requestFlush` 改 private（API-03） | 1 行 | 0 | 0 |
| **小计** | | **-78** | **+65** |

### 第二波 · 中风险中收益（依赖第一波，1 周内可完成）

| 步骤 | 涉及 ID | 行数变化 | 测试改动 |
|---|---|---|---|
| ⑦ 抽 `class ConfigurationBinding`（MOD-03） | 1 闭包 → 1 类 | -10 | +15 |
| ⑧ `model.ts` 拆 `model-domain.ts` + `model-ports.ts`（MOD-02） | 文件切分 | 0 | 0 |
| ⑨ `observe` 调用点统一参数（API-02 子项） | 7 处去 `{}` 默认 | -7 | 0 |
| ⑩ `setSubmission` 改为 immutable update（STATE-02） | 2 调用点 | -3 | +5 |
| **小计** | | **-20** | **+20** |

### 第三波 · 高收益大改动（依赖第一二波，2 周内可完成）

| 步骤 | 涉及 ID | 行数变化 | 测试改动 |
|---|---|---|---|
| ⑪ `manager.ts` 拆分为 6 个协作者类（ARCH-10 / §1.3 蓝图） | 642 → 6×100 | 0（净） | +50（新增状态机/资格真值表测试）|
| ⑫ `ScheduleHost` 5 回调合并为 2 动作（ARCH-11） | 接口 + 实现 | -10 | 0 |
| ⑬ 抽出 `HostAdapter implements ScheduleHost`（ARCH-12 / API-02） | 1 类 | -18 | 0 |
| ⑭ `synchronize` 拆为 subscription / query 两个子函数（MAINT-06） | 1 → 2 | -15 | +10 |
| ⑮ `attach` 拆为 `tryAttach` + `applyDelivery`（MAINT-07） | 1 → 2 | -10 | +5 |
| ⑯ `publishResult` / `publishError` / `deliver` 收敛为 `dispatch`（FLOW-04 / MAINT-08） | 3 → 1 | -25 | +10 |
| ⑰ `manager.ts` 段落注释精简（MAINT-09） | -40 注释 | 0 | 0 |
| ⑱ `model.ts` JSDoc 精简（MAINT-10） | -60 注释 | 0 | 0 |
| **小计** | | **-118** | **+75** |

### 第四波 · 可选（依赖第三波，1 周）

| 步骤 | 涉及 ID | 备注 |
|---|---|---|
| ⑲ `app.ts` 的 `createNamespace` 抽到 `namespace.ts`（ARCH-13） | 工具函数提取 |
| ⑳ `Clock` 端口迁到 `clock.ts`（MOD-04 子项） | 跨文件类型集中 |

### 总收益预估

| 指标 | 当前 | 完成全部路线后 |
|---|---|---|
| `manager.ts` 行数 | 642 | ≤ 80 |
| 最大函数体行数（估算） | ~50 | ≤ 25 |
| `if (` 集中度（manager.ts 占全库） | 51% | ≤ 10% |
| 公共操作面方法数 | 18 | 15 |
| 注释占核心行数 | ~25% | ≤ 12% |
| 测试代码/生产代码 | 42% | 50–55% |

---

## 10. 不在本版改动范围

以下内容是设计意图的合理选择，**不应被视为问题**：

1. **`diagnostics.ts` 与 `source.ts` / `delivery.ts` 双向依赖的 L0 叶子位置**——v4 已论证是必需
2. **`vue.ts → app.ts` 的等层承认边**——v4 已纳入双重闸门
3. **`structuredClone` 的依赖**——满足 C11 边界
4. **`nextIdentity` 耗尽时 `dispose` 的副作用**——本版只把 `dispose` 调用从纯函数内提到调用方，**耗尽仍触发 dispose**（这是 §3.2 中提到的设计意图"耗尽不是产品行为"，保留即可）
5. **测试通过 `inspect()` 访问内部事实**——这是 v4 已锁定的设计
6. **每个 `Source` 的 `validate` 是应用级常量**——G02 已确认

---

## 11. 结语

`vue-refresh` 已经是一个**架构方向正确、约束落实到位、契约封闭**的库。v4 解决了"谁写哪个字段"和"谁调谁"两个根本问题。**剩下的复杂度全部来自 `manager.ts` 的体积**——它在结构上合格，但在密度上仍处于"再分一块就崩溃"的边缘。

本版提出的三步路线图（第一/二/三波）不引入任何新概念、不破坏既有契约、不改变公共 API、不改变测试断言接口：

- **第一波**：6 项微调，全部 ≤ 30 行代码改动
- **第二波**：3 项结构调整，文件切分 + 闭包改类
- **第三波**：`manager.ts` 拆分；预计把最坏函数 CCN 从 ~12 降至 ≤ 5

**不做这些改动的代价**：`manager.ts` 642 行 / 56 个 `if` 仍会继续累积；下一个新需求（无论是新的资格条件、新的活动类型、新的交付语义）都将进入这个已经过载的文件。**做了之后**：核心复杂度再降一档、阅读半径缩到 ≤ 100 行、`DESIGN.md §3.3` 的"唯一所有者"从编译期事实进一步变成**结构层面事实**。

> 本报告所有结论基于代码静态阅读；执行需在 `pnpm typecheck` + `pnpm test` + `pnpm check:docs` 三项闸门全绿的前提下进行。任何一项改动后须立即回归全量测试与文档一致性校验。

---

## 附录 A · 关键代码位置索引（v5 实测）

| 主题 | 文件 | 行号 |
|---|---|---|
| `Manager` 类声明 | `src/manager.ts` | 44-642 |
| `Manager` 字段 | `src/manager.ts` | 46-60 |
| `Manager` 八个分段注释 | `src/manager.ts` | 84, 106, 198, 391, 485, 492, 573, 628 |
| `ScheduleHost` 接口 | `src/model.ts` | 223-234 |
| `ScheduleHost` 匿名实现 | `src/manager.ts` | 67-80 |
| `Delivery` 三态定义 | `src/model.ts` | 91-103 |
| `Submission` 接口 | `src/model.ts` | 106-109 |
| `Handle` 接口 | `src/model.ts` | 112-133 |
| `Resource` 接口 | `src/model.ts` | 136-149 |
| `QueryHost` 接口 | `src/model.ts` | 181-189 |
| `ConfigurationHost` 接口 | `src/model.ts` | 197-204 |
| `Clock` 接口 | `src/model.ts` | 167-173 |
| `enqueueTask`（双语义） | `src/manager.ts` | 399-413 |
| `attach`（4 早返回 + 2 条件交付） | `src/manager.ts` | 337-363 |
| `synchronize`（3 分支） | `src/manager.ts` | 201-221 |
| `releaseActivity`（默认参数） | `src/manager.ts` | 288-298 |
| `nextIdentity`（副作用耦合） | `src/manager.ts` | 564-571 |
| `currentOperation` / `currentQuery` | `src/query.ts` | 22-29 |
| `currentTask` / `currentSubscription` | `src/manager.ts` | 530-540 |
| `executeQuery`（结算模板） | `src/query.ts` | 60-103 |
| `failQuery`（结算模板） | `src/query.ts` | 38-51 |
| `useRefresh`（84 行） | `src/vue.ts` | 126-177 |
| `createConfigurationBinding`（42 行闭包） | `src/vue.ts` | 93-124 |
| `Scheduler.dueAt`（隐式约定） | `src/scheduler.ts` | 115-119 |
| `createNamespace`（与 app.ts 职责不直接相关） | `src/app.ts` | 34-42 |
