# vue-refresh 设计与实现

本文件维护设计与实现：模块划分、数据模型、参数与结果边界、调度与竞态、生命周期适配、顺序约束。
业务规则、公共 API 契约、验收目录与决策门槛的正式定义在 [统一刷新管理文档](./统一刷新管理.md)。
本版是根契约重写后的实现（见 [ADR.md](./ADR.md) ADR-27）：设计按「一个概念一份事实」重排，
不再是上一版的端口、投影与镜像字段。

**读代码的顺序建议：** 先看 §2.1（一次取数与交付的完整链路）和 §3.1（对象关系），再按 §3.9 的三条走读代入最容易
卡住的地方（交付重入、最后退出、上限到期），最后用 §3.3（所有权）与 §3.5（不变量，每条都注明**由谁保证**）核对细节。
`src/core.ts` 的七个 `═══` 分段与 §2 的七个分段一一对应。

## 1. 模块划分与依赖

工程目录：`vue-refresh/`。运行时分层：

```text
public-types.ts            公共类型的唯一代码定义与状态取值常量；不依赖运行时模块
source.ts                  固定资源定义、提交边界准备与稳定键
core.ts                    跨实例的协调者（注册表、名册、队列与并发、调度）＋ 一个身份的 Resource 类
vue.ts                     组件适配与安装：配置快照、句柄、生命周期、可见性、只读入口
index.ts                   包入口（三个函数、三个状态常量对象与 8 个公共类型）
```

依赖方向单向：`public-types` ← `source` ← `core` ← `vue` ← `index`。
核心不依赖 Vue 或任何状态库；运行期只依赖 `fast-json-stable-stringify`（零依赖，参数键的确定性编码）。这条方向由 `pnpm check:docs` 校验：
**运行期边必须严格向下**，同层或向上的运行期边必须同时在 `check-docs.mjs` 与本节登记，否则直接失败；
类型回边只报告（运行期被擦除）。本版没有需要登记的例外边。

`core.ts` 按职责分成七个分段：状态观测与生命周期、页面操作、观测面、需求关系、后台执行、刷新要求、调度。
全部可变状态都在 `core.ts`，按所属分两处：跨实例的挂在协调者上（注册表、名册、队列与并发、唯一唤醒 Timer），
一个身份自己的在 `Resource` 类里（订阅、刷新要求、结果、到期与当前任务），越过实例边界只调核心的两个入口；
`vue.ts` 只读公开入口与模块级单例（当前协调者），`source.ts` 是无状态函数的边界。

## 2. 模块职责

| 文件 | 职责 |
|---|---|
| `public-types.ts` | 公共契约类型、两个状态取值常量对象（`ErrorOrigin` / `CancelReason`）与 `RefreshSource`（成员是方法，靠双变进入框架的擦除视图） |
| `source.ts` | `defineRefresh`、`Parameters`、`prepareParameters`（复制 → 稳定编码 → 深冻结 → 执行来源的 `validate`）、只读定位 `parameterKey`；稳定编码用 `fast-json-stable-stringify` |
| `core.ts` | `RefreshCore`：跨实例的协调者——实例注册表、句柄名册、唯一 Timer 与 FIFO 队列、并发槽、只读计数投影；`Resource`：一个身份自己的状态与操作（订阅、刷新要求、到期、当前任务、交付与失败、结算与回收），越过实例边界只调核心的两个入口（`enqueue` / `releaseIfUnused`） |
| `vue.ts` | `useRefresh`（配置快照、句柄、Display、生命周期）、`createRefreshManager`（安装、可见性监听、只读入口、销毁）、注入槽位 |
| `index.ts` | 包导出：三个函数、三个状态常量对象、逐个列出的 8 个公共类型（不用 `export type *`）；工具型别名不导出 |

### 2.1 调用链路

适配层只提交「配置快照」和「参数准备动作」，资格、共享、调度与交付全部在核心。一次取数与交付只有这一条路径：

```text
useRefresh（组件 setup）
  ├─ 配置变化 → readConfig → Config 快照（非法为 null）→ RefreshCore.reconcile
  ├─ submit   → 推进声明代次 → prepareParameters → 换身份 → reconcile
  ├─ refresh  → 入口闸（销毁／配置非法／失去存在／无身份）→ 实例 → 刷新要求
  │             → 有当前请求就直接用它的结果，没有才登记一次共享任务
  └─ 生命周期 → onMounted / onActivated → activate；onDeactivated → deactivate；onScopeDispose → removeHandle

reconcile  = coordinate ＋ flushSoon（两步必须分开：coordinate 在 flush 里也会跑，那里不能再排 flush）
coordinate → 资格成立则接入实例或更新间隔，否则退订（失去存在时先结算未完成的刷新要求）
flush      → 协调句柄 → 一趟：到期入队 ＋ 收齐最早到期时刻 → 按 FIFO 占槽启动 → 安排唯一唤醒 Timer
runTask    → source.load → 复核任务身份 → 记结果与结算时刻 → Resource.publish → finally：清计时、释放槽位、补未满足的要求、再调度
expire     → 上限到期：先撤销在册身份 → abort → 按请求失败结算 → 补后继 → 再调度
Resource.publish → 有效订阅 ∪ 未结算的刷新要求，各一份独立副本 → 结算刷新要求（结算在交付之后）
```

实例与核心的边界只有两个入口：`enqueue`（排一次请求）、`releaseIfUnused`（没需求了就回收）
（没人要了就注销）。实例持有核心本身，但只用这两个入口；核心其余成员全部 `private`。

需求侧对应：`U01`–`U03` → `submit` 与 `resourceFor`；`U04`–`U06` → `coordinate`、`unsubscribe`、`releaseIfUnused`；
`U07`–`U10` → `Resource.dueAt`、`flush`、`runTask`、`expire`；`U11`–`U13` → `Resource.publish`、`Resource.fail`、`Resource.deliverTo`；
`U14` → `refresh`、`Resource.clearRequest`、`clearRefreshes`、`Resource.refill`；`U15` → `prepareParameters`、`parameterKey`；`U16`–`U18` → `isolate`、`report`、`nextSequence`、`dispose`。

## 3. 数据模型

本节是**内部字段、所有权与算法**的唯一维护入口；统一文档只保留对外含义与指针。

### 3.1 对象关系

```mermaid
flowchart LR
  Source[Source 固定业务定义] --> Parameters[Parameters 快照与 key]
  Handle[Handle 页面需求] --> Params[parameters: 已声明身份]
  Handle --> Sub[subscription: 实例 ＋ 间隔]
  Handle --> Pub[publish 出口]
  Sub --> Resource[Resource 共享实例]
  Resource --> Subs[subscribers: Set 句柄]
  Resource --> Waiters[waiters: 刷新要求]
  Resource --> Task[task: 当前执行]
  Resource --> Entry[entry: 最近一次结果]
  Resource -. 两个入口 .-> Core[RefreshCore 注册表 / 名册 / 队列 / 槽位]
```

`Handle.parameters` 是**声明的身份**，`Resource.parameters` 是**实例建立时用的参数**：前者是需求，后者是事实，
不是同一份数据的两个副本。`subscription` 只出现在句柄上，实例侧持有的是同一批句柄本身——
没有第二个对象描述同一条关系，因此不存在「两侧一致」这类需要维护的不变量。

`Resource` 是**类**而不是字段集合：一个身份内的转换都定义在它自己身上，核心不替它做决定；两者之间只有
两个入口（`enqueue` / `releaseIfUnused`）——核心因此不再需要中间接口，实例直接调它（ADR-42、ADR-44）。

### 3.2 身份与代次域

- Source 对象身份 ＋ `Parameters.key` 定位实例；实例的生存期由订阅与刷新要求共同决定。
- `Handle.operationId` 是**唯一的代次**：一个页面自己的声明序列，只用于错误的归属。
- 代次只在同一个句柄内递增；实例、刷新要求与页面身份都不共用这个计数——任务与结果都不记版本（ADR-45）。
- 代次域足够大（安全整数上界，单页每毫秒一次提交也要约 28.5 万年才到达）：到达上界后停在原地，
  不销毁协调者、不抛错，也不给调用方第三种结果（ADR-23 的结论在 `nextSequence` 上保留）。

### 3.3 持久字段与唯一所有者

类型形状由代码维护（`src/core.ts`、`src/source.ts`）；本表只维护所有权、初值与释放时机。

| 所有者 | 字段、初值 | 写入与释放 |
|---|---|---|
| Source | `load`、可选 `validate`；定义时冻结 | `defineRefresh` 唯一建立；所有使用方释放引用后回收 |
| Parameters | `args`、`key`；准备成功后只读 | 提交边界复制/冻结/编码；需求与实例释放后回收 |
| Handle | `operationId=0`、`parameters=null`、`subscription=null`、`cleanup=null`、`active=false`、`disposed=false` | 全部写入都在 `core.ts` 内：声明与关系由核心写，生命周期走 `activate` / `deactivate`，`cleanup` 走句柄字段；适配层只读它们。`source` / `config` / `publish` / `onError` 是固定端口；`publish` 声明为**方法**，方法参数双变，具体 `RefreshDisplay<P, T>` 因此可以直接进入擦除后的注册表槽位（ADR-24） |
| Resource | 类：`core`（只用它两个入口）、`source`、`parameters`、`subscribers` 空集合、`waiters` 空集合（`Set<Handle>`）、`entry=null`、`settledAt=null`、`task=null` | 首次接入或刷新要求创建；**一个身份只保留一份参数对象**：首次接入采用该句柄声明的那份，后续同键加入者改用实例已持有的那一份（同键等值且已冻结，`deliverTo` 与 `load` 也只用这一份）；`subscribers` / `waiters` 都空时由 `releaseIfUnused` 删除注册、结果、排队任务并 abort 在途；创建后参数不被新加入者改写。**一个身份内的转换都是它自己的方法**：`dueAt` / `shortestEvery` / `deliverLatest` / `publish` / `fail` / `clearRequest` / `refill`（`deliverTo` 私有）；核心只在跨实例边界读写 `task` / `entry`——入队（`enqueue`）与注销（`releaseIfUnused`） |
| Task | `resource`、`controller` | `enqueue` 创建（同一实例同时至多一个当前任务）；执行位置由 `queue` / `running` 决定；`finally` 释放真实槽位，`expire` 提前出册 |
| Entry | `data`、`updatedAt` | 当前有效成功时整条替换，时间取提交那一刻的墙钟；实例销毁时随实例消失 |
| RefreshCore | `buckets` / `handles` / `queue` / `running` 空集合；`wakeup=null`；`flushing=false`；`visible=true`；`cleanup=null`；`disposed=false` | 字段全部 `private`：外部只能走命名操作（`addHandle` / `removeHandle` / `activate` / `deactivate` / `setVisible` / `setCleanup` / `reconcile` / `submit` / `refresh` / `snapshot` / `isDisposed` / `dispose`），**另加两个给实例用的入口** `enqueue` / `releaseIfUnused`（public，但不在包契约内，见 ADR-42、ADR-44），其余内部转换全部 `private`；`dispose` 先失效再清理 |
| 配置快照与通知状态 | `snapshot`（初值非法）、`reported` | 名字见 `vue.ts`；只在适配闭包内，随组件作用域释放。快照同时是 `Handle.config` 返回的唯一事实，核心不重新调用 getter |

`snapshot()` 是给演示面板与集成测试的只读计数投影（集合是副本，元素仍是核心对象），
不属于包契约，也不提供改状态的入口。

### 3.4 事件与主流程

| 事件 | 同步转换 | 后续动作与重入边界 |
|---|---|---|
| `submit` 接纳 | 推进 `operationId`；参数通过后整体替换身份 | 参数被拒不改动任何状态；替换时先用旧身份结算刷新要求再退订 |
| 配置变化 | 适配层先写快照，核心按资格接入或退订 | `onError` / abort 可能重入；资格判断本身无副作用 |
| 隐藏 / 失活 | 结算本页未完成的刷新要求为 `unavailable`，退订 | 取消立即结算，不等底层结束 |
| `refresh` 接纳 | 把本句柄加进实例的要数集合，并在没有当前请求时登记一次任务 | 有请求就直接用它的结果；与自动刷新同一条路径；没有回执 |
| 后台成功 | 记结算时刻与结果、逐页独立副本、满足这一批要求 | 每次外部写入后复核任务归属；**每个接收者在交付点复核归属**；结算在交付之后 |
| 后台失败 | 记结算时刻、通知仍有效的订阅者、结算全部未完成要求 | 保留画面与需求，下个周期继续 |
| 上限到期 | 先撤销在册身份再 abort 与结算 | 迟到的结束因身份已失效被完全忽略 |
| 最后退出 | 删除注册、结果、排队项并 abort 在途 | 真实结束的任务在自己的 `finally` 里释放槽位 |
| `dispose` | 先置 `disposed`，再释放句柄、实例、队列、Timer 与监听 | 幂等；迟到执行只能清自己的槽位 |

### 3.5 必须成立的不变量

每条都注明**由谁保证**：读代码时按这里的符号名定位，不必先自己反推。

1. `subscription` 非空时，`handle.subscription.resource.subscribers` 一定含有该句柄；退订先把句柄字段清空再删集合成员。（`coordinate` 接入、`unsubscribe` 退出）
2. 注册表只指向当前生存期的实例；实例被删除后不再被 `flush` 遍历到，也不接受新的订阅。（`resourceFor` 建立、`releaseIfUnused` 删桶）
3. 每次调度都用当前 `subscription.every` 的最小值现算到期，不缓存「下次到期」以外的派生值。（`Resource.dueAt` / `Resource.shortestEvery`）
4. 一个实例至多一个当前任务；任务至多在 `queue` / `running` 之一；abort 不释放槽位，`expire` 除外。（`enqueue` 与 `runTask` 的 `finally` / `expire`；`flush` 排空时丢弃 `resource.task` 已不指向它的过期任务）
5. 结果只来自该实例的当前任务的成功；删除后旧请求不得重建该实例。（`runTask` 在 `await` 之后与复制结果之后各复核一次，`Resource.publish` 只被它调用）
6. 只有共享路径写结果与交付 `display`；DTO 与结果之间无可变别名，每个接收者各一份副本。（`Resource.publish` → `deliverTo` 的 `structuredClone`）
7. 当前任务的正常成功/失败在交付之前更新 `settledAt`；取消与旧任务不更新。（`Resource.publish` 与 `Resource.fail` 的第一行）
8. 订阅成立后 `handle.parameters === resource.parameters`：一个身份只保留一份参数对象，后加入者采用实例已持有的那一份。（`coordinate` 接入时改写句柄字段）
9. `dispose` 后句柄、注册表、队列、结果、Timer 与监听已清；未结束的执行到真实结束才移除。（`dispose` → 逐个 `removeHandle` → `buckets.clear`）
10. 框架上限由「开始执行时登记的一次性计时」表达；到期先撤销在册身份，之后任何迟到的结束都不再写事实。（`runTask` 的 `setTimeout` 与 `expire`）
11. 注销只发生在订阅与要求都空时，且空实例再也拿不到新的边：新订阅只能落在 `resourceFor` 当前返回的实例上，新要求也一样。（`releaseIfUnused` 是唯一注销点；`coordinate` 与 `refresh` 都经 `resourceFor`）

### 3.6 刷新要求的唯一更新表

`Resource.waiters` 是 `Set<Handle>`：**一个句柄此刻想要一次取数**。它是一个标志而不是队列——同一个句柄重复
刷新只留一份，而且**没有回执**（成功只经 `display`、失败只经 `onError`，ADR-46）。

| 事件 / 当前值 | 刷新要求更新 | 结果与交付规则 |
|---|---|---|
| `refresh`（无论实例有没有当前请求） | 把本句柄加进集合 | 有请求就直接用它的结果（排队或已在执行都一样）；没有请求就当场登记一次。不 abort、不追发第二次 |
| 同一实例多个句柄都要取数 | 各自保留 | 同一结果把它们一起满足 |
| 任务成功 | 这一批要求全部移除 | 先交付（含仅由刷新要求产生的接收者），再移除 |
| 任务失败或上限到期 | 该实例**全部**要求移除，并向这些页面各通知一次 `request` | 旧画面保留，订阅与开启意愿保留，下个周期继续 |
| 失去存在 / 卸载 / 销毁 | 撤销该句柄的要求，不通知 | `enabled` 边沿不撤销 |
| 实例再无订阅与要求 | 随最后一个要求移除而销毁实例 | 不引入 TTL 或历史缓存 |

一次失败的含义是「这次刷新没拿到新结果」：它撤销该实例**全部**未完成的要求并通知这些页面，因此不会变成自动重试，
与「失败保留画面、下个周期继续」一致（确认人 2026-09-17 裁决「有请求就直接使用，没启动就直接启动」，见 ADR-40）。

**唯一的不变量。** 上表可以由一条不变量表达：**存在未满足刷新要求的实例，必有当前请求，或由本次要求当场登记的那个请求**，
由它的结果满足。唯一的例外是交付回调里重入登记的要求：`Resource.publish` 先取这一批要求的快照再交付，交付期间新登记的
不在那一批里，只能由 `Resource.refill` 补的后继请求结算（§3.9 第一条）。

### 3.7 派生值：不重复保存

- 任务的执行阶段由 `queue` / `running` 的归属决定，不存字段。
- 下次到期时刻由 `settledAt ＋ 当前最短 every` 现算，因此改频率立刻生效；`settledAt` 本身是事实（最近一次正常结束）。
- 有效最短间隔由各订阅的 `every` 现算，不缓存。
- 资格由存活、已声明身份、生命周期与可见性、配置快照四组事实决定，不镜像 `enabled`。
- 不交付「正在刷新」这类实时状态：交付面只给结果与它的产生时间。

### 3.8 状态取值与存放

状态字面量的唯一来源是两个公开常量对象：`ErrorOrigin`、`CancelReason`（`public-types.ts`）。
子集类型（`SubmitResult` 的取消原因）在类型层写成可达成员的联合，
不新增第二个常量对象，也不手写差集求补。结果判别式（`status`）不单独枚举——判别联合本身就是这份枚举。

| 状态域 | 取值 | 存放 |
|---|---|---|
| 结果产生时间 | 墙钟 epoch 毫秒（不保证单调） | `Entry.updatedAt` → 交付时进入 `RefreshDisplay.updatedAt`；与调度的单调时间 `settledAt` 是两个域 |
| 错误来源 | `request` / `validation` / `configuration` | `RefreshError.origin`；交付面不交付「由谁触发」，这是唯一的来源域（ADR-34） |
| submit 取消原因 | 可达子集只有一个成员：`disposed` | `SubmitResult` 的 cancelled 分支 |
| 刷新要求 | 无 / 待满足（`Set<Handle>`） | `Resource.waiters` |
| 当前订阅 | 实例 ＋ 间隔 / `null` | `Handle.subscription` |
| 配置快照 | 有效 / 非法（`null`） | 适配闭包 → `Handle.config` |
| 组件激活、句柄已释放、浏览器可见、协调者已销毁 | true / false | `Handle.active` / `Handle.disposed` / `RefreshCore.visible` / `RefreshCore.disposed` |
| 待唤醒调度 | 取消句柄 / `null`；已排 flush true / false | `RefreshCore.wakeup` / `flushing` |
| 资源已结算 | 时刻 / `null`（从未结算） | `Resource.settledAt` |
| 当前后台任务 | Task / `null` | `Resource.task` |
| 任务执行位置 | 排队 / 执行中 / 都不是 | **推导**：`queue` / `running` 的归属 |
| 有效最短间隔 | 正安全整数 | **推导**：现算各订阅的 `every` 最小值 |
| 订阅资格 | 是 / 否 | **推导**：存活、已声明身份、环境允许、配置开启四组事实 |

### 3.9 三条路径的走读

这三条是读代码最容易卡住的地方：它们的行为依赖**前提**，而前提不写在函数体里。按符号名定位即可——
本节刻意不写行号，行号会随编辑失效。

**一、交付期间的重入（`Resource.refill` 为什么存在）**
`Resource.publish` **先**取这一批要求的快照，**再**逐个交付。交付会同步调用页面的
`publish` 回调，回调里可能立刻 `submit`、`refresh`、退订或卸载，因此：

- 每交付一个接收者之前重新复核它还在不在 `subscribers` 里——前一个回调可能已经让它退订；
- 交付期间新登记的要求不在这批里（它在 `Resource.publish` 算完之后才存在），只能由**后继请求**结算；
- `runTask` 的 `finally` 调 `Resource.refill`：仍有未结算要求且没有当前任务时补一次请求；这就是「唯一例外」的落地；
- 结算放在全部交付**之后**，所以 `await refresh()` 拿到 `success` 时，本页 `display` 已经是这次的结果。

**二、最后退出与迟到的结束（`releaseIfUnused` 凭什么只判「都空」）**
需求变空只有两个入口：`unsubscribe`（退订）与 `Resource.clearRequest`（要求被撤销或满足），`submit` / 隐藏 / 卸载
都经由它们。两者都调 `releaseIfUnused`，它只判 `subscribers` / `waiters` 是否真的都空，然后注销这个键——
不再另判「实例是否仍在册」：「都空」已经蕴含「在册」，因为注销是唯一的删除路径，而空实例再也拿不到新的边
（§3.5 第 11 条；ADR-44 删掉那次在册复核的依据）。注销做四件事：删注册、
清 `entry`、清 `task`、`abort` 在途；还在排队的任务同时从 `queue` 移除。
`abort` 不承诺底层立刻结束，所以迟到的 `load` 返回由 `runTask` 的身份复核（`resource.task !== task`）判为无效：
不写结果、不交付、不二次通知；它的 `finally` 只清自己的计时与槽位。

**三、上限到期（为什么先撤销身份再 abort）**
`runTask` 从真正开始执行时登记一次性计时；到期走 `expire`，顺序是**先** `resource.task = null`、`running.delete`，
**再** `abort`、`Resource.fail`、`Resource.refill`。这个顺序就是全部要点：`abort` 与失败通知都会同步重入页面代码，
而此刻这次执行的在册身份已被撤销，因此它在 `await` 之后的任何返回都被身份复核判为无效；槽位当场交还
（`running.delete`），不等底层结束——所以 `maxConcurrent` 约束的是**在册任务数**，不是底层连接数。

## 4. 参数与结果边界

### 4.1 参数准备与键

固定 Source 绑定 `P`、`T`、`load` 及可选同步 `validate`。输入按普通 JSON 记录使用；框架**不判断值是否合法**——那是调用方的责任，编码交给 `fast-json-stable-stringify`，沿用 JSON 语义：`-0` 与 `0` 同键，`NaN` / `Infinity` 按 `null`，`undefined` 与函数字段按省略，`Date` 按其 ISO 字符串。传函数、Proxy 这类复制不了的值由 `structuredClone` 拒绝（`validation`），循环引用由编码包抛 `TypeError`。

提交边界**一次**执行；两件事各由一个函数负责，副作用只出现在其中一处：

```text
structuredClone → stringify（`fast-json-stable-stringify`：键排序 ＋ 数组保序）
                → deepFreeze（唯一副作用：冻结这份副本）
                → 可选 Source.validate 一次 → Parameters
```

对象按键排序编码，数组保持原顺序，因此字段顺序不影响身份、数组顺序影响身份。
**不设内部深度上限**：循环引用让编码交不出身份（`parameterKey` 返回 `null`），与复制失败一样按非法参数处理（`U15`）。
`validate` 每次接纳提交执行一次；轮询、恢复与显式刷新都不执行。
`validate` 返回 Promise 属于契约违约：同步抛错是给调用方的主信号，那个 Promise 也被观察掉，不产生未处理拒绝。

### 4.2 观测面

`snapshot()` 是给演示面板、基准脚本与集成测试看的**只读计数投影**（不属于包契约）：句柄名册、实例数组、
排队与在途任务、唯一唤醒 Timer 与「已排 flush」的布尔值。集合是副本、元素仍是核心对象（比较身份是这些断言的要点），
因此它是观察面而不是安全边界。

它**不再包含按参数键拍平的结果字典**：那会把「Source ＋ 参数值」的身份压成一个键，两个不同 Source 用同一个键
就会互相覆盖（ADR-46）。要看某个实例的结果就读 `snapshot().resources` 里它的 `entry` 字段——包本身不提供读取入口：
结果只经页面自己的 `display` 交付，需要落到业务 Store 的页面在自己的适配层写。

### 4.3 数据所有权

- DTO 业务校验由 `load` 所在的 HTTP 适配器负责。
- 框架拒绝 `undefined` 并执行 `structuredClone`；不做原型白名单、自有描述符、循环或复制后形状复核。
- 原生支持的 `Date` / `Map` / 循环等可被复制，**不表示**框架验证了业务合法性；不支持的值由原生复制抛错，
  沿用共享请求失败处理；`null` 是有效结果。
- 结果 → 每个接收者各复制一份（`display` 是唯一出口）；不冻结业务原对象，不用 JSON 来回 `parse`。
- **参数与结果的所有权不同**：结果每个接收者复制一份（`structuredClone`），参数按**引用**交付——`Resource.deliverTo` 把
  `resource.parameters.args` 直接交给每个页面，它同时是每一轮 `load` 的实参。因此参数在提交边界被 `deepFreeze`
  冻结：不冻结的话，一个页面写自己的 `display.args` 就会同时改掉别人的画面、下一轮请求的参数与身份键所描述的值。
  这也是它必须**深**冻结（`Object.freeze` 是浅的）而结果只需逐份复制的原因。
- 退订冻结依靠独立数据快照，不能直接绑定共享结果对象，也不能只复制最外层对象。

### 4.4 复杂度

- 参数提交：复制一次、结构遍历两次（编码一次、冻结一次）、可选业务校验一次。按值展开参数规模记 K，成本 `O(K)`。
- DTO 入站复制 `O(D)`，k 页交付 `O(kD)`；结果是整条替换，不维护增量结构。
- 调度按实例与订阅扫描；FIFO 出队按任务数。
- 规模结论见[统一文档](./统一刷新管理.md) §5 G04。

## 5. 调度、并发与竞态

### 5.1 一次 flush

```text
清本轮标记并取消旧 Timer
→ 协调当前全部句柄
→ 一趟遍历：到期实例入队，同时收齐其余实例的最早到期时刻
→ 按 FIFO 和可用槽位启动
→ 队列已空且仍有到期项时安排唯一唤醒 Timer
```

**这一轮只读一次时钟。** `Resource.dueAt` 接收这个读数，不在函数内再读一次：真实时钟在一次 flush 内会前进，
两次读数会把「从未结算的实例立即到期」变成「尚未到期」，于是首次入队被推迟到一个 0ms Timer。
新追加的任务留到下一次 flush；满槽时不自旋，等到任务真实结束或上限到期后继续；间隔超过平台 Timer 范围时分段等待。

### 5.2 并发与上限

- `queue` / `running` 是执行位置的唯一事实：`running` 统计真实尚未结束的任务，也就是并发槽。
- 显式刷新与自动刷新共用队列与 `maxConcurrent`；满槽排队，不绕过上限。
- **框架上限**从任务真正开始执行起算（排队不计入），数值 `10000` 毫秒由确认人给出（ADR-20）。
  到期按共享请求失败结算并立即出册，因此挂死的传输、忘了拒绝的适配器、把长连接当一次 `load` 的封装
  都不能让槽位永久被占。abort 会取消该计时。
- 出册后这次执行迟到的结束在任务身份复核处被判无效：不写结果、不交付、不二次通知。
- 因此 `maxConcurrent` 约束的是**在册任务数**：被上限结算的任务不再计入，其底层请求可能仍未结束。
  上限不代替适配器自己的业务超时——那是调用方的事实，框架不猜。abort 不承诺服务端立即停止。

### 5.3 结果有效性

需要复核身份的边界是：`await` 之后、复制结果之后、写结果之后、交付每个接收者之前。
普通只读判断不触发外部效果。后台成功时先准备接收者与副本，再逐页交付；每个交付点重新判断订阅与要求归属。
历史结果不要求原任务仍存活，但必须满足当前订阅或未结算的刷新要求。

## 6. 生命周期与 Vue 适配

### 6.1 配置快照

- watch 源只读 `options.enabled.value` 与 `options.every.value`；两项都是必填的 `Ref`，改值即改配置。
- 任一项读不出或值非法时快照为 `null`：不订阅、不自动刷新、连续非法只通知一次，修正后按当前资格恢复。
- 读不到的开关绝不推断成 `false`：页面可以用 `computed` 表达暂态条件（例如
  `enabled: computed(() => store.ready && store.on)`），框架下一轮再读。
- 核心只读这份快照，不重新调用业务 getter；快照不是可独立修改的第二份开启意愿。
- `readConfig` 是 watch 的取值函数，因此必须同步、纯、不抛：整体只兜一层 `catch`（任一项读不出即返回 `null`）。
  **边界**：某一项 getter 抛错时，它之后的项当轮不再被读取，Vue 也会清掉当轮未重新收集的依赖，
  恢复要靠抛错那一项自身的变化。常见的「配置非法」是值不对（`undefined` / 非布尔）而不是抛错，
  那种情况三项都会读完、依赖齐全；要让三项在任何情况下都各自完成依赖收集，就得逐项捕错（旧实现的写法，多 4 行）。
- `every` 只接受正安全整数毫秒，不转换、不取整；只在 `enabled` 为真时必需，省略而开启为真按配置非法拒绝。

### 6.2 生命周期

- `mounted` / `activated` 恢复资格，`deactivated` / scope dispose 撤销；两者可能交叠（KeepAlive），因此进入与退出都幂等。
- 浏览器隐藏同步退订，恢复按资格加入。
- 暂停后仍允许显式 `refresh`；`enabled` 边沿只按资格退订，不结算已发起的刷新要求。
- 生命周期取消不报请求失败、不修改开启意愿。
- 重新显示时：实例仍在则交付已有结果并按间隔调度；已销毁则重建并首查。
- 自定义页签由调用方提供响应式可见条件；初始隐藏时不请求。

### 6.3 安装与单例

- 安装顺序固定为「先检查后修改」：被拒的安装不破坏已有合法绑定，也不新增监听或请求。
- 每个协调者只注册一个 `visibilitychange` 监听。
- 当前协调者放在模块级变量里：安装时若现有实例还活着就拒绝，已销毁则直接替换（HMR、会话切换），
  组件适配不经过 `provide` / `inject`。
- `dispose` 先失效再清理自身监听与资源；卸载钩子调用 `dispose`。

### 6.4 通知隔离

- `onError` 同步执行，返回的 Promise 拒绝立即观察但不等待，不阻塞其他接收者。
- 框架**调用**的 `publish` / `onError` / `cleanup` 抛错或返回拒绝的 Promise 都只被吞掉，
  不改变已定结果、订阅、调度与其他接收者的交付；框架自身不写诊断日志。
- 隔离面恰好是这三类回调：`load` 拿到的 `AbortSignal` 上的监听器由宿主在 `abort()` 时同步调用，
  它们的抛错由宿主上报，框架 catch 不到，因此不在承诺内。
- 后台失败保留需求与开启意愿，旧画面不变，下个周期继续；框架不改写调用方的 `enabled`。

## 7. 顺序约束

1. **先建立新身份，再作废旧关系。** 新任务与新声明必须先就位，再 abort 旧执行。
2. **先让内部关系完整失效，再产生外部效果。** 退订先清句柄字段与集合成员，再删结果，最后 abort。
3. **外部效果之后复核身份。** `await`、复制结果、交付每个接收者之前都要重新判断归属。
4. **旧清理只清自己。** 旧执行的 `finally` 只移除自己的槽位成员。
5. **资格判断无副作用。** `coordinate` 与 `Resource.dueAt` 只读事实。
6. **槽位只在两种情况下变化。** 真实结束释放自己的槽位；上限到期先撤销在册身份再出册。
7. **配置只读快照。** 适配层的同步 watch 是唯一写入者。

## 8. 验证

`pnpm typecheck` → `pnpm test` → `pnpm check:docs` → `pnpm build` → `pnpm build:demo` → `pnpm test:browser`；
`pnpm complexity` 输出每文件与函数的行数、结构分支、圈复杂度和嵌套深度。
实际执行环境与已通过项见 [README](./README.md)「实际验证与边界」。
测试预期属于契约，修正测试前先确认契约。
