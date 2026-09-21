# vue-refresh 设计与实现

本文件维护设计与实现：模块划分、数据模型、参数与结果边界、调度与竞态、生命周期适配、顺序约束。
业务规则、公共 API 契约、验收目录与决策门槛的正式定义在 [统一刷新管理文档](./统一刷新管理.md)。
本版是根契约重写后的实现（见 [ADR.md](./ADR.md) ADR-27）：设计按「一个概念一份事实」重排，
不再是上一版的端口、投影与镜像字段。

**读代码从 §9 开始**：那里有三条进入路线、读之前先记住的七个词、每个符号的一句话作用，以及
「遇到 `if` 时它在防什么」的对照表。`src/core.ts` 的五个 `═══` 分段与 §2.1 的分工一一对应。

## 1. 模块划分与依赖

工程目录：`vue-refresh/`。运行时分层：

```text
public-types.ts            公共契约类型（判别联合，没有常量对象）；不依赖运行时模块
source.ts                  参数边界：准备（复制、值域检查、稳定键）
resource.ts                一个身份自己的状态与判定（每页一份的 `Config` 配置槽 ＋ `Resource` 类）
core.ts                    跨实例的协调者（身份注册表、队列与并发、调度）
store.ts                   结果表（Pinia 模块级定义）：URL → 参数键 两级分组，整条替换，随实例释放即删
vue.ts                     组件适配与安装：配置槽原地改写、生命周期、可见性、读闸门、结果表接线
index.ts                   包入口（两个函数与 6 个公共类型；没有常量对象）
```

依赖方向单向：`public-types` ← `source` ← `resource` ← `core` ← `store` ← `vue` ← `index`。
核心不依赖 Vue 或任何状态库，也不 import 任何 HTTP 客户端：取数用的 axios 实例由 `createRefreshManager` 注入，
`core.ts` 只调它的 `post`。**`store.ts` 是唯一 import Pinia 的模块**，核心只经 `ResultSink` 的四个动作碰结果表。运行期只依赖 `fast-json-stable-stringify`（零依赖，参数键的确定性编码）。这条方向由 `pnpm check:docs` 校验：
**运行期边必须严格向下**，同层或向上的运行期边必须同时在 `check-docs.mjs` 与本节登记，否则直接失败；
类型回边只报告（运行期被擦除）。本版没有需要登记的例外边。

`core.ts` 按职责分成五个分段：状态观测与生命周期、页面操作、身份注册表、后台执行、调度。
全部可变状态分三处：跨实例的挂在协调者上（身份注册表、队列与并发、唯一唤醒 Timer），
一个身份自己的在 `Resource` 类里（声明者、这一轮的结果产出了没有、到期与当前执行），**结果住结果表**（`store.ts`，唯一真值）；
实例不持有核心——写表、回收、排队都是核心的动作（ADR-65）。
`vue.ts` 只读公开入口、模块级单例（当前协调者与结果表）与结果表的读出口，`source.ts` 是无状态函数的边界。

## 2. 模块职责

| 文件 | 职责 |
|---|---|
| `public-types.ts` | 公共契约类型（判别联合，没有常量对象）：数据出口、失败出口、句柄、协调者、选项与提交结果 |
| `source.ts` | 参数边界：`Parameters`、`assertJsonValue`（值域检查：对象型限普通对象或数组）、`prepareParameters`（复制 → 值域检查 → 稳定编码，消费者各拿副本；**不跑任何回调**）、`parameterKey`；`P` 的值域约束 `JsonParameters` 也在这里，由 `useRefresh` 的类型参数使用；稳定编码用 `fast-json-stable-stringify` |
| `resource.ts` | `Resource`：一个身份自己的状态与判定（声明者、这一轮是否已产出／是否还欠一轮、到期、当前执行、成功与失败结算），**不持有核心**——写表、回收、排队都是核心的动作（ADR-65）；`Config`：**一页在核心里的登记**——每页一个可变配置槽，适配层原地写、核心只读（ADR-66） |
| `core.ts` | `RefreshCore`：跨实例的协调者——身份注册表、唯一 Timer 与有序队列（手动刷新插到队头）、并发槽、结果表写入端与读取口 |
| `store.ts` | 结果表：模块级 `defineStore`，`URL → 参数键 → ResultCell 四字段` 两级分组，`shallowRef` 整条替换；写入端给内核（`write` / `fail` / `remove`），读出口给内核的读取面（`read`），`list` 给观测面 |
| `vue.ts` | `useRefresh`（每页一份 `Config` 配置槽、公开 `RefreshHandle`、指向结果表的 Display、**读闸门**、生命周期）、`createRefreshManager`（安装、可见性监听、结果表接线、销毁） |
| `index.ts` | 包导出：两个函数、逐个列出的 6 个公共类型（不用 `export type *`）；工具型别名不导出 |

### 2.1 调用链路

适配层只提交「一页一份配置槽」和「参数准备动作」，资格、共享与调度全部在核心，结果写进结果表。一次取数只有这一条路径：

```text
useRefresh（组件 setup）
  ├─ 配置变化 → readConfig → RefreshCore.setConfig：写这一页的 Config 并重排调度
  ├─ submit   → prepareParameters → 换身份（resourceOf 扫描 → 摘旧 declarers → 挂新）→ 排一次调度
  ├─ refresh  → 入口闸（已释放／销毁／配置非法／失去存在／无身份）→ 实例
  │             → 没有执行就插到队头；有执行且结果还没产出就什么都不做（这一轮够用）
  │             → 有执行且结果已经产出就记一笔，本轮结束时再排一次（enqueue 插队头 / needsNext）
  ├─ 读取面   → 写入事件唤醒（flush: 'sync' 副作用）→ store.read（已声明身份）→ 数据出口：同一身份同一版不抄第二遍 / 窗口比较 / 没有读取时间就直接读 → 整格抄进 display
  │             同一个副作用里还有失败出口：这一格换了一笔新的失败就立刻抄进 failure（不等窗口），成功后清回 null
  └─ 生命周期 → onMounted / onActivated / onDeactivated 改写配置槽里的 `active`；onScopeDispose → released ＋ undeclare

setConfig  = 写这一页的配置槽并重算一次到期与唤醒（三个值非法只把 every 置 null）
flush      → 清旧 Timer（clearWakeup）→ enqueueDue（到期入队并收齐最早到期时刻）→ startQueued（按队列次序占槽启动）→ 队列空了就安排唯一唤醒 Timer
run        → http.post(URL, 参数副本) → 复核当前执行 → Resource.settle(at)（记结算时刻、置 produced）→ 核心写表 → finally：释放槽位 ＋ 清 produced ＋ 有 needsNext 就插到队头补一轮 ＋ 再调度（失败走同一条 `Resource.settle(at)`，只是核心写的是同一格的失败那一对字段）
Resource.settle  → 成功与失败都走它：只记结算时刻与「这一轮已经产出」（失败也算结算，因此不自动重试）；写表与回收都在核心
display（数据出口）→ 写入驱动：结果表写入唤醒本页副作用 → 按 updatedAt 时间差节流（一个 every 窗口最多换一次画面）→ 整格抄进 display
failure（失败出口）→ 同一个副作用里的第二件事：这一格最近一次失败换了就立刻抄进 failure（不参与窗口），成功后清回 null
```

实例与核心之间没有调用关系：`Resource` 只给出状态与判定，写表（核心直接调 `sink.write` / `sink.fail`）、
回收（`releaseIfUnused`）、排队（`enqueue` / `dequeue`，队列是数组）与补一轮全部是核心的私有动作，
核心其余成员也全部 `private`（ADR-65、ADR-70）。

锚点侧对应：`U01`–`U03` → `submit` 与 `resourceFor`；`U04`–`U06` → `isEligible`、`undeclare`、`releaseIfUnused`；
`U07`–`U09` → `Resource.dueAt`、`flush`、`run`；`U11`–`U13` → `Resource.settle`（成功与失败都只记时刻、置「这一轮已经产出」）、核心写表时的 `sink.write` / `sink.fail`、`useRefreshStore`；
`U14` → `refresh` 的三条分支、核心私有的 `enqueue` 与「补一轮」；`U15` → `prepareParameters`、`parameterKey`；`U16`–`U18` → `vue.ts` 提交边界（参数准备的抛错就地变同步 `rejected`）、`dispose`、`display` 的写入驱动节流。

## 3. 数据模型

本节是**内部字段、所有权与算法**的唯一维护入口；统一文档只保留对外含义与指针。

### 3.1 对象关系

```mermaid
flowchart LR
  Url[资源：URL 字符串] --> Parameters[Parameters 快照与 key]
  Url -. 同一个 URL .-> Config[Config 每页一份配置槽，就是它在核心里的登记]
  Config -. 按身份读 .-> Table[结果表: URL → 参数键 → ResultCell 四字段]
  Resource[Resource 共享实例] --> Decl[declarers: 装 Config 的声明者集合]
  Resource --> Round[produced / needsNext ＝ 这一轮产出了没有 / 还欠一轮]
  Resource --> Controller[controller: 这次执行]
  Core[RefreshCore 身份注册表 / 队列 / 槽位] -. 写表、回收、排队 .-> Resource
  Core -. sink .-> Table
```

`Config` **就是这一页在核心里的登记**：每页一个对象、适配层原地改写，谁声明了这个身份 ＝ 这个对象挂在哪个实例的
`declarers` 里。`Resource.parameters` 是**实例建立时用的参数**（框架私有权威副本）；页面侧的「我按哪个身份读」
由适配层自己持有的身份键现查结果表得到。声明关系**只有一处事实**——实例侧 `declarers` 的成员资格，
配置槽上没有指向实例的反向字段，`resourceOf` 换身份时扫描注册表，所以不存在「两侧一致」这类需要维护的不变量（ADR-57、ADR-66）。
**`Resource` 也不持有核心——配置与实例都不指向核心**：写表、回收与排队都是核心越过去做的动作，因此三方之间没有环（ADR-65）。
**声明与资格是两件事**：声明由挂载/卸载与身份变化驱动；资格（配置开启、这一页激活、浏览器可见）只决定要不要取数，
现算、不维护第二份集合（ADR-61）。**「读者」不是核心的概念**：核心只回答 `isEligible` 与 `isVisible` 两个只读判定，
页面在这一拍上跟不跟随由适配层的读闸门自己算（ADR-66）。

`Resource` 是**类**而不是字段集合：一个身份内的状态与判定都定义在它自己身上，核心不替它做决定；
实例**不持有核心**，核心也不需要中间接口——写表、回收与排队都是核心越过去做的动作（ADR-65）。
**`Resource` 是合并请求、排队与终止的单位**：同一个「URL ＋ 参数值」只有一个实例（合并发生在 `resourceFor`），
一次执行只属于它、只在它的 `queue`／`running` 位置上排队，取消（abort）与回收也只在它身上发生（ADR-66）。
**结果不在实例上**：它住结果表，读的人按已声明身份自己取，因此没有「交付」这一步，也没有逐个接收者的副本（ADR-59）。

### 3.2 身份

- URL（一个字符串）＋ `Parameters.key` 定位实例（声明不再有对象或函数，ADR-75）；同一个 URL 与同一份参数值就是同一个实例，因此两处各写一份定义也照样合并。实例的生存期只由声明决定（最后一个声明者离开就回收）。
- **没有第二套计数**：执行与结果都不记版本或代次，读取面也不带「由谁触发」的标记
  （ADR-43 删掉等待者的版本下限、ADR-45 删掉任务版本、ADR-47 删掉声明代次）。

### 3.3 持久字段与唯一所有者

类型形状由代码维护（`src/resource.ts`、`src/core.ts`、`src/source.ts`）；本表只维护所有权、初值与释放时机。

| 所有者 | 字段、初值 | 写入与释放 |
|---|---|---|
| Parameters | `args`、`key`；框架私有，不外发 | 提交边界复制/查值域/编码；外发给消费者（每轮请求体）时各复制一份；`display.args` 每次抄写再复制一份（它是身份键那份值）；配置槽与实例释放后回收 |
| Config | `{ enabled, every, present }`；**每页一个对象**，适配层在 `useRefresh` 里建立（初值 `enabled=false`、`every=null`、`present=false`） | 适配层把三个值交给核心的 `setConfig`，在一个同步块里写进三格（单一写入口）；核心不重新调用业务 getter。**它同时就是这一页在核心里的登记**——这个对象挂在哪个实例的 `declarers` 里，就等于这一页声明了哪个身份，因此没有第二份名册（ADR-66）。`every === null` ＝ 这一拍配置非法（不取数、不刷新、不算有资格），它与「暂停」（`config.enabled=false` 而 `every` 仍有效）是两件事；`present` ＝ 环境允许（这一页激活且浏览器可见），由适配层合成后报进来（A04、A05、ADR-87）。随本页作用域释放（`onScopeDispose` → `released` ＋ `undeclare`）；核心不 import 定义对象，也没有任何回调字段（ADR-64） |
| Resource | 类：`url`、`parameters`（一个身份只保留一份参数对象）、`declarers` 空集合（`Set<Config>`）、`produced=false`（这一轮的结果已经产出）、`needsNext=false`（产出之后又有人点过刷新，本轮结束再排一轮）、`settledAt=null`、`controller=null` | 首次声明创建；**一个身份只保留一份参数对象**：首次声明采用那份已准备参数，后续同键加入者复用实例已持有的那一份（同键等值，是框架内部唯一权威副本；外发给消费者时各复制一份，ADR-52）；`declarers` 空时由 `releaseIfUnused` 删除注册、结果表条目、排队执行并 abort 在途。**一个身份内的状态与判定都是它自己的方法**：`dueAt` / `eligibleEvery` / `isPresent` / `isCurrent` / `hasExecution` / `isWanted` / `isEligible` / `settle(at)`——最后一个（成功与失败都走它）：只记结算时刻并把 `produced` 置起，写表与回收由核心做；实例不持有核心（ADR-65），核心越出实例边界只碰 `controller`（由 `enqueue` ／ `run` 的收尾 ／ `releaseIfUnused` 迁移，§3.5 第 4 条）与 `declarers` 的增删（`submit` / `undeclare`），那两个位由 `refresh` 与 `run` 读写（§3.6、§3.9 第一条）。**这里不记「谁要的」**：刷新是给身份的一句命令，核心不留任何「欠一张」的账（ADR-70） |
| 结果表（`store.ts`） | `cells`：`URL → 参数键 → ShallowRef<ResultCell \| undefined>`，`ResultCell = { data, updatedAt, error, failedAt }` 四字段全平（`updatedAt === null` ⟺ 从未成功过，`failedAt === null` ⟺ 自最后一次成功以来没失败过）；初值 `undefined` | 模块级 `defineStore`，一个 Pinia 实例一张表；写入端只由内核用（`write(url, key, data, updatedAt)` 写成功、`fail(url, key, error, failedAt)` 写失败、`releaseIfUnused` 删、`list` 列举），读出口是 `read`；**整格换新对象**（`shallowRef`，格与 `ResultCell` 都当不可变用）——读取面比较引用就知道变没变，因此不引版本号（ADR-63）；失败**保留**已有的 `data` 与 `updatedAt`；实例释放时只把格置 `undefined`（cell ref 不删，依赖关系才稳定），条目随之消失（A06） |
| RefreshCore | `identities`（身份键 → 实例，一层）/ `queue`（数组：只表达待取顺序）/ `running`（在途集合：并发槽；两者都直接装 `Resource`，没有独立的执行对象）；`wakeup=null`；`flushing=false`；`disposed=false` | 字段全部 `private`：外部只能走命名操作（`isDisposed` / `setConfig` / `submit` / `refresh` / `isEligible` / `readResult` / `undeclare` / `dispose`）；这 8 个是全部公开面，其余内部转换全部 `private`；核心私有的动作是 `resourceOf`（**扫描**注册表找出这份配置登记在哪个实例上，不存反向字段，ADR-57）、`resourceFor`（查／建实例）、`releaseIfUnused`（回收：`declarers` 空才注销，并把这一份账连同这次执行的认人一起作废）、`enqueue`（排进队尾或插到队头，并给它这次执行的把手）、`dequeue`（从队里摘掉）、`enqueueDue`（到期入队并收齐最早到期时刻）、`startQueued`（按队列顺序占槽启动）、`run`（收尾顺序的唯一处：结算 → 写表 → 交还槽位 → 有 `needsNext` 就插到队头补一轮）；`dispose` 逐个实例清空 `declarers` 后再 `releaseIfUnused`（回收即从注册表与队列里摘掉，所以不需要再整表清空）。**核心不持有任何回调**（`setCleanup` 随 ADR-64 删除）：可见性监听的拆卸由适配层自己做（§6.3） |

只读计数投影（演示面板、基准脚本与集成测试看的四个字段）不属于包契约，因此也不住在核心上：
它随 ADR-79 移到开发侧的支撑模块 `scripts/observe.ts`（§4.2），核心不再有这个成员。

### 3.4 事件与主流程

| 事件 | 同步转换 | 后续动作与重入边界 |
|---|---|---|
| `submit` 接纳 | 参数通过后换身份：`resourceOf` 扫描 → 从旧实例 `declarers` 摘掉 → 挂到 `resourceFor` 给出的实例 | 参数被拒不改动任何状态；相同身份幂等（不摘不挂）。换身份**在旧实例上不留任何账**（核心不记「谁要的」，ADR-70）：旧实例没人声明了就当场回收 |
| 配置变化 | 适配层把三个值交给 `setConfig`：一个同步块里写完配置槽（含这一页的 `active`）并重排 | 核心按新资格重算到期与唤醒；写结果表 / abort 可能重入，资格判断本身无副作用 |
| 隐藏 / 失活 / 暂停 | 不再取数、这一页不再是读者（画面冻结；失活或隐藏期间连 `refresh` 的入口闸也不放行） | 声明不撤销：实例、结果与在途都留着；恢复时读回已有结果 |
| `refresh` 接纳 | 三条分支（核心不记是谁点的）：**没有执行** → 插到队头；**有执行、结果还没产出** → 什么都不做（这一轮的结果就够，A14）；**有执行、结果已经产出** → 记一笔，本轮结束时再排一轮 | 与自动刷新同一条路径；没有回执。同一轮内点几次合并成一次（那是一个位），跨轮则每点一次补一轮 |
| 后台成功 | `Resource.settle(at)` 先记结算时刻并把「这一轮已经产出」置起 → 核心写表 | 每次外部写入后复核当前执行归属；**先记时刻、再写表**（写表可能同步触发页面再点一次刷新，那一次落在下一轮）；页面在结果表上按身份自己读 |
| 后台失败 | `Resource.settle(at)` 同形（失败也算结算，因此不自动重试）→ 核心把失败写进结果表同一格（已有的 `data` 与 `updatedAt` 保留） | 不推送：页面靠自己的失败出口（`failure`）在写入时**立刻**取走这笔失败——它不参与数据窗口（ADR-77）；下个周期继续 |
| 声明空 | 最后一个声明者离开（卸载／换身份／销毁）→ 删除注册、结果表条目、排队项并 abort 在途 | 真实结束的执行在自己的 `finally` 里释放槽位；这里没有第二个条件——刷新不记账，所以「声明空」就是「没人要了」（ADR-70） |
| `dispose` | 先置 `disposed`，再逐个清空实例的 `declarers` 并回收（回收即从注册表与队列里摘掉，不需要再整表清空） | 幂等；迟到执行只能清自己的槽位；可见性监听由适配层自己摘（核心不持有回调） |

### 3.5 必须成立的不变量

每条都注明**由谁保证**：读代码时按这里的符号名定位，不必先自己反推。

1. 声明关系只有一处事实：这一页的 `Config` 在某实例的 `declarers` 里 ⟺ 它声明了该身份。登记只 `add`（`submit`）、撤销只 `delete`（`undeclare`），没有第二份需要保持同步的副本；**资格不另存集合**，由 `config.enabled && config.active && RefreshCore.visible` 现算。（`resourceOf` 扫描定位、`releaseIfUnused` 回收；ADR-57、ADR-61、ADR-66）
2. 注册表只指向当前生存期的实例；实例被删除后不再被 `flush` 遍历到，也不接受新的声明或刷新命令。（`resourceFor` 建立、`releaseIfUnused` 删桶）
3. 每次调度都在**有资格的声明者**里现算 `every` 的最小值：没有有资格的声明者就不取数、不安排唤醒。不缓存间隔，也不缓存「下次到期」以外的派生值。（`Resource.dueAt` / `Resource.eligibleEvery`）
4. 一个实例至多一个当前执行；执行的位置由 `queue`（数组：待取顺序）与 `running`（在途集合：并发槽）两处表达，成员只在 `enqueue` ／ `dequeue` ／ `startQueued` ／ `run` 的收尾 ／ `releaseIfUnused` 里迁移；「这次执行还算不算数」另存为 `Resource.controller`，`controller === null` 同时表达「没有执行」与「这次结束已不算数」，因此不需要独立的执行对象。abort 不释放槽位（回收时只把它从队列摘掉并清空 `controller`，请求仍占着 `running` 里那一格直到自己结束）。队列里的实例恒握着这次执行的把手，`startQueued` 不需要归属复核；同一实例在队里至多一个（`enqueue` 不去重，靠调用点保证、由探针守着）（ADR-56、ADR-62、ADR-65、ADR-70）
5. 结果只来自该实例的当前执行的成功；删除后旧请求不得重建该实例。（`run` 在 `await` 之后与复制结果之后各复核一次 `resource.controller !== controller`，`Resource.settle` 只被它调用）
6. 结果只由共享路径写入结果表（成功与失败都在 `run` 里各写一次 `sink.write` / `sink.fail`；实例的 `settle` 只记结算时刻并置「这一轮已经产出」），写的是**同一个对象**，读的人拿到它也是同一个对象——要改自己复制；`display.args` 仍然每次抄写复制一份。（ADR-59、ADR-65）
7. 当前执行的正常成功/失败在写结果表之前更新 `settledAt`；取消与旧执行不更新。（`Resource.settle` 的第一行）
8. 一个身份只保留一份参数对象：首次声明采用那份已准备参数，后加入者复用实例已持有的那一份；**核心不再把这份参数回写页面**——`display.args` 来自适配层自己那份副本（`submitted`），页面改它改不到请求体或身份键。（`resourceFor` 采纳；ADR-52、ADR-66）
9. `dispose` 后配置、注册表、队列、结果表条目与 Timer 已清（核心不持有监听或任何回调）；未结束的执行到真实结束才移除。（`dispose` → 逐个清空 `declarers` → `releaseIfUnused`）
10. 注销只发生在声明空时，且空实例再也拿不到新的边：新声明只能落在 `resourceFor` 当前返回的实例上，刷新的命令也只能落在注册表里现存的实例上。（`releaseIfUnused` 是唯一注销点；`submit` 经 `resourceFor`，`refresh` 按 URL ＋ key 现查注册表）
11. 有资格 ⟹ 配置槽有效：`enabled` 为真、`present` 为真、`every` 是正安全整数（`present` 已含激活与可见）；因此最小间隔可以直接现算，不必在实例上另存一份。（`Resource.isEligible`）
12. 两个出口只在写入与边沿上变，而且各有各的粒度：**数据出口**的每次发布都由「身份落定／重新成为读者／点过一次刷新（这三处把这一页的上次读取时间置 `null`）／一次写入且距画面里那一版满一个 `every`」之一触发，**同一身份**的同一版（数据时间没变）不抄第二遍，窗口内的新版本不改变画面；**失败出口**由「这一格换了一笔新的失败（`failedAt` 变了，或从有到无）」触发，**不受窗口限制**，成功后是 `null`。两个出口发布的永远分别是那一格的成功侧与失败侧，因此都不需要版本号。（`vue.ts` 的 `publishData` / `publishFailure`；ADR-63、ADR-67、ADR-72、ADR-77）
13. 「读者」只在适配层判定：核心不认识页面、也不回答谁该跟随结果表，只提供 `isEligible` 一个只读判定；适配层自己算 `core.isEligible(config, url, key) || (lastReadAt === null && !document.hidden)`（第二项＝「这一页还没有读取时间且浏览器可见」），**两个出口共用这一个闸门**。（§6.4；ADR-66、ADR-67、ADR-72、ADR-77）

### 3.6 刷新：给身份的一句命令

`refresh()` 不是一份要存起来的申请，而是**给身份下的一句命令**：现在再取一次。核心不记是谁点的、也不记
「还欠谁一次」（ADR-70）——同一身份的结果对所有读者是同一格，谁点的不改变要取的那份数据。

| 事件 / 当前值 | 命令落点 | 结果规则 |
|---|---|---|
| `refresh`，实例**没有执行** | 插到队头（`enqueue(resource, true)`） | 手动刷新是「人正等着」的取数，排在到期取数前面；与自动刷新共用同一条队列与并发槽 |
| `refresh`，有执行、**结果还没产出** | 什么都不做 | 这一轮的结果就够（A14：有在途就直接用它的结果，不追发第二次） |
| `refresh`，有执行、**结果已经产出** | `needsNext = true`（一个位） | 这一轮已经写完了新结果，它要的必然是下一轮；本轮结束时补一次 |
| 同一轮内点几次 | 合并成一次 | 一个位，重复点只留一份——与哪一个页面点的无关 |
| 执行成功 / 失败 | `settle(at)` 记结算时刻、置 `produced`（两种结局都走它），核心写表；`run` 的 `finally` 清 `produced` 并按 `needsNext` 插到队头补一轮 | 先记时刻、再写表、再收尾；失败也算这一轮的结算，因此不自动重试 |
| 失去资格（隐藏 / 失活 / 暂停） | 不产生新的命令 | 已经排上的取数照常走完（资格只在入队时判定）；失活或隐藏期间 `refresh` 的入口闸不放行，暂停页仍可刷新一次，恢复后照旧 |
| 卸载 / 销毁 | 命令无处可落（按 URL ＋ key 查不到身份） | 声明空即回收；结果表条目随实例释放删掉：不引入 TTL 或历史缓存 |

一次失败的含义是「这次刷新没拿到新结果」：失败写进这一格（不推送、不改开关、不自动重试），与「失败保留
画面、下个周期继续」一致（确认人 2026-09-17 裁决「有请求就直接使用，没启动就直接启动」，见 ADR-40）。

**一个位为什么够了（改判 ADR-66 的一处记录）。** ADR-66 把「身份级一个布尔（`needsNext`）」记为「试过并否掉」；
本轮采纳——保留这个位的**用途**（区分「结果还没出来」与「结果已经写进表」），把「谁在等」从核心整个拿掉。
当时那次实验的真正教训是「**一个位不够回答『哪个页面还没拿到』**」，而新口径下这个问题不再需要回答：
页面按自己的数据新鲜度读结果表（ADR-67 的时间差节流），要一次新的就再下一条命令（ADR-70）。
**试过并否掉的**：连「补一轮」也拿掉（有执行时刷新一律不排队）——不记 `produced` 就无法区分 A14（结果还没
出来：这一轮就够，不追发）与 A12（结果已写进表：要下一轮），两条验收必坏其一（ADR-70）。

**上界（明说）。** 旧口径下「一个页面同时只能有一次未满足的刷新请求」，因此「每写一次结果就点一次刷新」
的页面最多多取一轮。新口径下**这个上界没有了**：那种页面会一直取下去——页面自己的循环就是页面自己的
循环，框架只保证同一轮内合并（ADR-70）。由谁保证：`RefreshCore.refresh` 的三条分支与收尾时的补一轮；
写表那一刻同步重入的那条路径见 §3.9 第一条。

### 3.7 派生值：不重复保存

- 执行的位置由 `queue` / `running` 的归属决定；此外另存一个「本实例的当前执行」位 `Resource.controller`（它要回答的是「这次迟到的结束还算不算数」，不是位置）。两处只在 `enqueue` ／ `dequeue` ／ `startQueued` ／ `run` 收尾 ／ `releaseIfUnused` 里迁移，`controller === null` 同时表达「没有执行」与「这次不算数」（§3.5 第 4 条，ADR-65）。
- 下次到期时刻由 `settledAt ＋ 当前最短 every` 现算，因此改频率立刻生效；`settledAt` 本身是事实（最近一次执行有结局，成功与失败都算）。
- 有效最短间隔由各声明者的 `every` 现算，不缓存。
- 资格由「声明还在」「配置开启且有周期」「这一页激活」「浏览器可见」四组事实现算，不镜像 `enabled`，也不存第二份集合（`Resource.isEligible`）；后两组由适配层合成快照里的 `present`（ADR-87）。
- 声明到哪个实例由该实例 `declarers` 的成员资格决定，配置槽上不存反向字段；`resourceOf` 换身份时扫描注册表（ADR-57、ADR-66）。核心**不再有名册**：这一页是否已释放由适配层的 `released` 自己记（§6.2）。
- 不提供「正在刷新」这类实时状态：读出口只给结果与它的产生时间。
- 「我该看到哪一条」不另存：适配层由自己持有的身份键现查结果表得到（ADR-59、ADR-66）。
- 「本页还跟不跟随结果表」不另存、也不问核心：适配层现判 `core.isEligible(config, url, key) || (lastReadAt === null && !document.hidden)`（ADR-60、ADR-66、ADR-72）。

### 3.8 状态取值与存放

取值域直接写在 `public-types.ts` 的判别联合里，**没有常量对象**（ADR-51）：调用方比较裸字面量。
结果判别式（`status`）不单独枚举——判别联合本身就是这份枚举；单成员取值不立字段（`submit` 的取消分支不带原因）。

| 状态域 | 取值 | 存放 |
|---|---|---|
| 结果产生时间 | 墙钟 epoch 毫秒（不保证单调） | `ResultCell.updatedAt` → 读出口把它带进 `RefreshDisplay.updatedAt`；与调度的 `settledAt` **用的是同一个墙钟**（一次取数里那个 `at` 同时是结算时刻与结果时间，所以两者可以直接比较，不需要第二个时钟）；代价是墙钟被回拨时下一次到期会等到时钟追平（`dueAt` 与 `setWakeup` 都按 `Date.now()` 现算） |
| 当前结果 | 每个身份一格 `ResultCell` / 没有 | **结果表**：`useRefreshStore().read(url, key)` 拿那一个 cell ref 的值；写由核心直接调 `sink.write` / `sink.fail`，删由 `releaseIfUnused`，读由页面按身份现查 |
| 这一轮的结果产出了没有 | true / false | `Resource.produced`：`settle` 在写表之前置起，`run` 的 `finally` 清回 false |
| 还欠一轮 | true / false | `Resource.needsNext`：`refresh` 在「有执行且已产出」时置起，`run` 的收尾读它并插到队头补一次 |
| 当前声明 | 声明着 / 未声明 | **推导**：这一页的 `Config` 是否在该实例的 `declarers` 里；`resourceOf` 扫描注册表（ADR-57、ADR-66） |
| 配置槽取值 | 有效 / 非法（`every === null`） | `Config` 字段：唯一写入口是核心的 `setConfig`（适配层给三个值），核心只读 |
| 环境允许（这一页激活且浏览器可见）、本页已释放、协调者已销毁 | true / false | `Config.present`（适配层合成后并进配置槽，ADR-61、ADR-87）/ 适配层的 `released`（**核心不再有名册**，ADR-66）/ `RefreshCore.disposed` |
| 待唤醒调度 | 取消句柄 / `null`；已排 flush true / false | `RefreshCore.wakeup` / `flushing` |
| 资源已结算 | 时刻 / `null`（从未结算） | `Resource.settledAt` |
| 当前执行 | 有 / 没有 | `Resource.controller`（`null` ＝ 没有执行，或这次结束已不算数） |
| 执行位置 | 在队 / 在跑 / 被弃（在跑但已不是当前执行）/ 都不在 | `RefreshCore.queue` / `running`；「这次执行还算不算数」另存为 `Resource.controller`，两处只在 `enqueue` ／ `dequeue` ／ `startQueued` ／ `run` 收尾 ／ `releaseIfUnused` 里迁移（§3.5 第 4 条） |
| 有效最短间隔 | 正安全整数 | **推导**：现算各声明者的 `every` 最小值 |
| 取数资格 | 是 / 否 | **推导**：声明还在、环境允许（激活与可见合成在快照的 `present` 里）、配置开启且有周期（`Resource.isEligible`，ADR-61） |

### 3.9 三条路径的走读

这三条是读代码最容易卡住的地方：它们的行为依赖**前提**，而前提不写在函数体里。按符号名定位即可——
本节刻意不写行号，行号会随编辑失效。

**一、写表时的重入（`produced` 与「补一轮」为什么存在）**
`run` 的收尾顺序是 `Resource.settle(at)`（记结算时刻、把 `produced` 置起）→ 核心写表 → `finally`：交还槽位、
清 `produced`、有 `needsNext` 就插到队头补一轮。写表会同步触发 Vue 的响应式副作用
（例如页面里 `flush: 'sync'` 的 watcher 读了 `display` 又去 `refresh()`），因此：

- 写表那一刻 `produced` 已经为真，于是这次重入落进第三条分支：`needsNext = true`；
- `run` 的收尾见到 `needsNext` 就插到队头——这就是「本轮结束再排一次」的落地；
- 顺序固定「先记结算时刻、再写表」：写表那一刻页面知道的是**这一轮已经产出**，它要点的是下一轮，不会与本轮混淆；
- 页面在结果表上读，所以写表返回时本页 `display` 已经能读到这次的结果；
- **同一轮内点几次都合并成一次**（`needsNext` 是一个位）；跨轮则每点一次补一轮——上界不再与「谁在等」有关（§3.6 的注）。

**二、最后退出与迟到的结束（`releaseIfUnused` 凭什么只判「都空」）**
声明变空只有一个入口：`undeclare`（撤销声明）——`submit` 换身份与卸载都经由它。它调 `releaseIfUnused`，
只判 `declarers` 是否空，然后注销这个键——
**暂停、失活、隐藏都不撤销声明**，所以它们不会走到这一步（这正是「失活恢复直接读回」的原因，ADR-61、ADR-66）。
不再另判「实例是否仍在册」：「声明空」已经蕴含「在册」，因为注销是唯一的删除路径，而空实例再也拿不到新的边
（§3.5 第 10 条；ADR-44 删掉那次在册复核的依据）。注销做四件事：删注册、
**删结果表条目**、撤销当前执行、`abort` 在途；在跑的那次标为**被弃**——它仍占着并发槽位，直到迟到的结束自己交还，
而当场交还就会让在途的请求与后来者并发；还在排队的执行同时从 `queue` 摘掉（`releaseIfUnused` 里的 `dequeue`）。
`abort` 不承诺底层立刻结束，所以迟到的响应由 `run` 的身份复核（`resource.controller !== controller`）判为无效：
不写结果、不动结果表；它的 `finally` 只清自己的槽位。

**三、为什么一次执行不再需要独立对象（ADR-65）**
框架不再自带单次取数的截止，因此一个实例同时只会有一个执行：`enqueue` 时诞生一个 `AbortController`
存进 `Resource.controller`，结束时由 `run` 的收尾清回 `null`。一个字段同时回答两件事——**取消**（释放实例时 `abort`）
与**认人**（`run` 在 `await` 之后、复制结果之后、写表之前各复核一次 `resource.controller !== controller`，
迟到的结束因此被丢弃）。过去承担「这一次执行」的那个独立对象随上限一起删除；请求必然终止由注入的传输负责
（axios 的 `timeout`、反向代理或宿主自己的截止），框架不再设内部截止。

## 4. 参数与结果边界

### 4.1 参数准备与键

资源就是「URL ＋ 参数值」这条身份：URL 与 `P`／`T` 都在 `useRefresh<P, T>(url, …)` 那一行写出，框架里没有声明对象。`P` 的值域由 `JsonParameters` 约束为 JSON 值（对象型只能是普通对象或数组，ADR-52），提交边界再由 `assertJsonValue` 运行期兜底：`Date`／`Map`／`Set`／`RegExp`／`ArrayBuffer` 等容器的内容对编码不可见，两个内容不同的参数会塌成同一个身份，故一律拒绝（`Date` 请传 ISO 字符串）。业务字段的合法性仍不归框架——那是调用方自己的事：它在 `submit` 之前自己判，框架不替它跑回调（ADR-74）。编码交给 `fast-json-stable-stringify`，标量沿用 JSON 语义：`-0` 与 `0` 同键，`NaN` / `Infinity` 按 `null`，`undefined` 字段按省略；函数与 Proxy 这类复制不了的值由 `structuredClone` 拒绝，循环引用让编码交不出身份。

提交边界**一次**执行；三步各由一个函数负责，没有共享、也没有需要冻结的副作用：

```text
structuredClone → assertJsonValue（值域：对象型限普通对象或数组）
                → stringify（`fast-json-stable-stringify`：键排序 ＋ 数组保序）
                → Parameters
```

对象按键排序编码，数组保持原顺序，因此字段顺序不影响身份、数组顺序影响身份。
**不设内部深度上限**：循环引用让编码交不出身份（`parameterKey` 返回 `null`），与复制失败一样按非法参数处理（`U15`）。
**框架不跑任何调用方代码**（ADR-74）：提交边界只有复制、值域检查与编码三步，没有 `validate` 这类准入回调；业务准入由调用方在 `submit` 之前自己判——输入是它自己的东西，离它最近。

### 4.2 观测面

观测面不属于包契约，因此也不住在 `src/`：只读计数投影一度是 `RefreshCore.snapshot()`，现已随 ADR-79 移到
开发侧的支撑模块 `scripts/observe.ts`（一个读核心私有账本的纯函数）。它只有四个字段：实例数组 `resources`、
**结果表的一份扁平副本**（`results`：`url` / `key` / `cell` 三列，`cell` 是 `ResultCell` 的四个平字段 `{ data, updatedAt, error, failedAt }`）、排队与在途执行（`queued` / `running` 都是 `Resource[]`）。`declarers`、`scheduled`、`flushing` 三个投影字段已删除（ADR-74、ADR-79）：声明者列表可由 `resources.flatMap(r => [...r.declarers])` 现推，另外两个是核心内部状态。
集合是副本、元素仍是核心对象（比较身份是这些断言的要点），因此它是观察面而不是安全边界；
支撑模块每次越界读私有账本前先做形状校验，内部结构漂移当场抛错，而不是静默返回空。

结果那一项带 `url` ＋ `key`，所以两个 URL 用同一个参数键不会互相覆盖（ADR-46 删掉的是只按参数键拍平的字典）。
包本身仍然不提供「按身份读」的公开入口：**页面侧读的是自己的 `display`**（一个指向结果表的只读视图），
要用在别处就在页面自己的适配层里读它，框架不做第二个出口。

### 4.3 数据所有权

- DTO 业务校验由取数所在的传输侧负责（本仓示例是 `demoHttp`，接入方通常是 axios 响应拦截器）。框架拿到的是
  `response.data`，只做结果边界检查（拒绝 `undefined`、原生复制），不做形状复核——因此畸形响应在框架看来是
  一次**成功**：它会覆盖旧结果。要不要挡住它，是传输侧的决定。
- 框架拒绝 `undefined` 并执行 `structuredClone`；不做原型白名单、自有描述符、循环或复制后形状复核。
- 原生支持的 `Date` / `Map` / 循环等可被复制，**不表示**框架验证了业务合法性；不支持的值由原生复制抛错，
  沿用共享请求失败处理；`null` 是有效结果。
- **失败也是那一格的事实**（ADR-63）：它不动最后一次成功的数据，只把 `error` 与 `failedAt` 换上；成功一到，`failedAt` 清回 `null`。
  页面在写入上**立刻**读到它（ADR-77 的失败出口，不参与数据窗口），所以「成功过的身份上失败被窗口挡住」这个缺口不存在；
  框架不引失败计数（ADR-43／45／47 删过版本与代次计数）。
- **结果的读出口与参数不同**（ADR-59）：结果只复制一次（入站 `copyResult` 建立框架私有所有权），
  之后**所有人读到的都是同一个对象**——要改自己复制，只读视图由 `ReadonlySnapshot` 在编译期约束；
  不冻结业务原对象，也不用 JSON 来回 `parse`。代价说清楚：一个页面就地改它，其他页面与下一次读都跟着变。
- **参数仍是每个消费者各复制一份**（`structuredClone`，ADR-52）：提交边界复制一份作为框架私有权威副本，
  每一轮请求体各拿一份，`display.args` 每次读取也复制一份，因此页面写自己的 `display.args` 改不到
  下一轮请求的参数或身份键所描述的值。**隔离不靠冻结**：`Object.freeze` 冻的是
  属性描述符，而 `Map.set` / `Set.add` / `Date.setTime` 写的是内部槽，规范上冻不住——既然私有副本不外发，
  就不需要「冻得住」这个假设。

### 4.4 复杂度

- 参数提交：复制一次、值域遍历一次、编码遍历一次（不再另复制一份给任何回调，ADR-74）。按值展开参数规模记 K，成本 `O(K)`；每次读 `display` 再复制一次参数，k 页即 `O(kK)`。
- DTO 入站复制 `O(D)`；结果不再逐页复制，读的人拿到同一份（ADR-59），因此没有 `O(kD)` 这一项；结果是整条替换，不维护增量结构。
- 调度按实例与声明扫描；出队按队列次序（手动刷新在队头）与可用槽位。
- 读取面按页计时：每页每次写入一次整格比较（`O(1)`）＋ 命中时复制一次参数（`O(K)`）；`every` 越大，抄写次数越少——慢页面的静态成本就是这个乘积。
- 规模结论见[统一文档](./统一刷新管理.md) §5 G04。

## 5. 调度、并发与竞态

### 5.1 一次 flush

```text
flush：清本轮标记（flushing = false）→ 已销毁则返回 → 取消旧 Timer（clearWakeup）
→ enqueueDue：一趟遍历，到期实例入队，同时收齐其余实例的最早到期时刻
→ startQueued：按队列次序和可用槽位启动（队列里的执行必是它实例的当前执行，不再复核）
→ 队列已空且仍有到期项时安排唯一唤醒 Timer
```

**这一轮只读一次时钟。** `Resource.dueAt` 接收这个读数，不在函数内再读一次：真实时钟在一次 flush 内会前进，
两次读数会把「从未结算的实例立即到期」变成「尚未到期」，于是首次入队被推迟到一个 0ms Timer。
新追加的执行留到下一次 flush；满槽时不自旋，等到执行真实结束后继续；间隔超过平台 Timer 范围时分段等待。

### 5.2 并发与限流

- `queue` / `running` 是执行位置的唯一事实：`running` 统计真实尚未结束的请求，也就是并发槽。
- 显式刷新与自动刷新共用队列与 `maxConcurrent`；满槽排队，不绕过这个上限。
- **框架不给单次取数设自己的截止**（ADR-65，作废 ADR-20 的 `10000` 毫秒）：请求必然终止由注入的传输负责——
  axios 的 `timeout`、反向代理，或宿主自己的截止。一个永不结束的请求会永久占住一个并发槽，
  直到它的传输自己结束；框架不再有「挂死请求不会让应用停摆」这条保证，也不设内部截止。
- 实例被释放后这次执行迟到的结束在身份复核处被判无效：不写结果、不动结果表；但它仍占着槽位。
- 因此 `maxConcurrent` 约束的是**在途请求数**（含已释放实例那次仍占着槽的请求）；abort 不承诺服务端立即停止。

### 5.3 结果有效性

需要复核身份的边界是：`await` 之后、复制结果之后、写表之前（写进结果表这一刻必须仍是当前执行）。
普通只读判断不触发外部效果。后台成功只做两件事：把结果写进结果表、给这一轮收尾（清 `produced`，有 `needsNext` 就补一轮）；谁在读、读几次由适配层的读闸门决定。
历史结果不要求原执行仍存活；它随实例释放而消失（A06），因此「回来就有」只在实例仍活着时成立。

## 6. 生命周期与 Vue 适配

### 6.1 配置槽

- watch 源读模块级的安装槽、`options.enabled.value`、`options.every.value` 与这一页的 `active`；两个 `Ref` 都是必填，改值即改配置，**换协调者也重新报一遍**——装上那一刻新协调者拿到的是这一页**当前**的配置，不是旧协调者留下的那份槽。
- 每页一份可变配置槽（`Config`），**唯一写入口**是核心的 `setConfig`：两个 `Ref` 与这一页的激活状态在一个同步块里
  写进同一份槽；非法时只把 `every` 置 `null`（＝这一拍配置非法）——不取数、不自动刷新、不写结果表，修正后按当前资格恢复（ADR-51、ADR-66）。
  槽是可变对象，外部看不到半更新，全靠「中间不调用任何会回到框架的东西」。
- 读不到的开关绝不推断成 `false`：页面可以用 `computed` 表达暂态条件（例如
  `enabled: computed(() => store.ready && store.on)`），框架下一轮再读。
- 核心只读这份配置槽，不重新调用业务 getter；它不是可独立修改的第二份开启意愿。
- `readConfig` 是 watch 的取值函数，因此必须同步、纯、不抛：整体只兜一层 `catch`（任一项读不出即返回非法值）。
  **边界**：某一项 getter 抛错时，它之后的项当轮不再被读取，Vue 也会清掉当轮未重新收集的依赖，
  恢复要靠抛错那一项自身的变化。常见的「配置非法」是值不对（`undefined` / 非布尔）而不是抛错，
  那种情况 `options` 的**两个 `Ref`** 都会读完、依赖齐全；要让两项在任何情况下都各自完成依赖收集，
  就得逐项捕错（旧实现的写法，多 4 行）。配置槽里的第三项 `active` 不是调用方的 getter，而是适配层自己的
  `shallowRef`（watch 取值函数在 `readConfig` 之外读它），因此不参与这段边界（ADR-61）。
- `every` 只接受正安全整数毫秒，不转换、不取整，且**任何状态下都必须有效**：「配置有效」是刷新入口闸的一部分（§6.4、`U14`），所以只想手动刷新的页面也要给一个正数周期（`enabled=false` ＋ 有效 `every`）。`enabled=true` 而 `every` 读不出或不是正安全整数时整槽按非法处理（不取数、不自动刷新、不写失败，修正后自动恢复）。

### 6.2 生命周期

- `mounted` / `activated` / `deactivated` 只改写配置槽里的一项 `active`（唯一写入口是那个 `flush: 'sync'` 的 watcher）；三者可能交叠（KeepAlive），因此写入必须幂等。
- 浏览器隐藏只是让所有页面失去资格（不再取数、画面冻结），声明与结果都留着；已经排上的取数照常走完，恢复可见后按到期继续。**可见性由适配层并进每页快照的 `present`**（ADR-87）：隐藏与恢复各页重报一次，核心因此重排调度。
- 暂停后仍允许显式 `refresh`（入口闸不看 `enabled`，只看激活、可见与配置有效）；`enabled` 边沿只改变资格，不撤销声明，也不影响已经发出的那次取数。
- `onScopeDispose` 先置 `released`（此后 `submit` 返回 `cancelled`、`refresh` 无副作用），再停表、`undeclare` 并清空本页身份（§2.4「取消只有一个来源」）。
- 生命周期取消不报请求失败、不修改开启意愿。
- 重新显示时：实例仍在则按已声明的身份从结果表读回已有结果并按间隔调度；已销毁则重建并首查。
- 自定义页签由调用方提供响应式可见条件；初始隐藏时不请求。
- **读取面由写入事件驱动、分两个出口**（ADR-63、ADR-67、ADR-72、ADR-77）：没有自己的 Timer——`store.write`／`fail`
  替换 cell 后，`flush: 'sync'` 的副作用同步醒来，先判**读闸门**（有资格，或「还没有读取时间」且浏览器可见；下一小节），
  再发布两件事——
  **① 数据出口（`display`，按本页 `every` 节流）**：状态只有**一个数** `lastReadAt`（上一次抄进数据出口的那一版数据的
  `updatedAt`；`null` ＝ 还没有读取过）。(a) **同一身份同一版不抄第二遍**：画面里那一版的**身份键**和 `updatedAt` 都跟这一格一样才返回
  （换身份后两个从未成功的格 `updatedAt` 都是 `null`，只比时间会把新身份的 args 挡在外面）；
  画面本身是「已经抄到的那一版」，另存它属于哪个身份；(b) **窗口**：`lastReadAt !== null && every !== null && cell.updatedAt !== null &&
  lastReadAt + every > cell.updatedAt` ⇒ 不换画面（慢页面要的就是不跟快页面跳）；没有可比的时间（本页还没读到过、
  或这一格从未成功过）就直接读；(c) **发布整格**（`args` / `data` / `updatedAt`），并把 `lastReadAt` 记成这一版的
  `updatedAt`。
  **② 失败出口（`failure`，不参与窗口）**：这一格最近一次失败换了（**身份键**或 `failedAt` 变了，或从有到无）就发布
  `{ error, failedAt }`，成功是 `null`；失败那一笔不动 `updatedAt`，所以它按数据窗口永远进不来——这正是它要独立成
  一个出口的原因（「有没有失败」看这个对象在不在，不看 `error` 是什么）。
  写端稀于本页 `every` 时写入即抄（比固定窗口更及时）；写端密且 `every` 非整数倍时实际更新周期被量化到写入网格
  （例：写入每 100ms、`every=150`，实际约 200ms 一版；确认人接受的代价）。窗口是结果时间戳之差，不保证与墙钟
  对齐。**本页一个 Timer 都没有。**
- **三处「没有读取时间就直接读」**：身份落定（`submit` 真的换了身份；同身份重复 `submit` 是幂等的，不动这个基准）、重新成为读者（配置/生命周期 watcher）、显式
  `refresh()`——它们都只把 `lastReadAt` 置 `null`，下一份内容因此不受窗口限制（首查结果、失活恢复、手动刷新都
  不会被窗口拖后）。**失去资格那一侧（暂停、失活、隐藏）不清**：清了读闸门第二项就会把整个失活期放行、画面在
  后台一路跟下去，「失活冻结」就没了（ADR-72）。
  **配置变化不叫醒读取面（ADR-73）**：唤醒那个副作用的只有两件事——**这一格被写入**、**这一页换了身份**。
  watcher 只做两件与此有关的事：把 `lastReadAt` 清掉（于是**下一份写入**不受窗口限制）、让核心重算调度。
  因此「重新成为读者」与另外两处的差别是：首查与手动刷新本身就是写入触发的，而重新成为读者要等**下一份写入**
  才上屏（≤ 一个共享窗口；表里已有一版更新又恰好没有新写入时，页面先显示自己冻结的那一帧）。
- **发布是同步的（ADR-89）**：页面 watcher 在发布当中换身份或卸载时，本轮快照立即作废（不再把旧身份的结果写进画面），
  并由一次微任务强制唤醒读取面——正在运行的副作用不会被自己触发的变更唤醒，新身份那一格的依赖必须靠这一下重新订上。
- **一处角落（明说）**：读闸门第二项只问「还没有读取时间」（`lastReadAt === null`）且浏览器可见，**不问此刻是否
  激活**。两侧各有一条明确行为：**还没读到过**的暂停页会跟着第一份到达的数据上屏一次（此后它有了上次读取时间就
  冻住；真 Chrome 的 A11 断言 `shown(乙) === 111` 钉住）；**点过刷新之后才失活**的页面，那一帧仍会在后台更新
  （确认人 2026-09-17 的裁决「允许它更新一帧呗」——「同一版不抄第二遍」这一步保住了那个置空的读取时间，用例
  `A04/A06 点过刷新之后失活：缓存里那一帧仍会更新；失活期间点刷新不产生事实` 钉住）。反向的那一半：**失活或
  隐藏期间才点 `refresh` 的什么都不产生**（入口闸要求这一页激活、配置有效且浏览器可见）；A04／A06 的验收
  （失活不产生请求、画面保留、激活读回同一份结果）两条都照旧成立。

### 6.3 安装与单例

- 安装顺序固定为「先检查后修改」：被拒的安装不破坏已有合法绑定，也不新增监听或请求。
- 每个协调者只注册一个 `visibilitychange` 监听。
- 当前协调者放在模块级变量里：安装时槽里有占位者就拒绝；槽里只会有活着的协调者（`uninstall` 在 `core.dispose()` 之前置空），
  所以「已销毁就能原地接管」靠的是槽空着，而不是安装时现场判死活（HMR、会话切换），
  组件适配不经过 `provide` / `inject`。安装槽本身是配置 watcher 的依赖，因此接管后每一页在下一拍把当前配置
  重新报给新协调者；身份仍要由调用方 `submit` 登记（核心不接旧协调者的登记）。
- `dispose` 先失效再清理自己的队列／Timer／实例与配置槽；卸载钩子调用 `dispose`。**核心不持有任何回调，适配层的拆卸由适配层自己做**：`install` 在 `app.onUnmount` 里摘掉可见性监听、返回的 `dispose()` 也摘（ADR-64）。

### 6.4 零回调与读闸门

- **核心不调用任何页面代码**：`core.ts` 拨出去的外部调用只剩两个注入端口——传输 `http.post(...)`
  与结果表 `sink.write / fail / remove / read`；它们都是适配层传进来的端口，不是页面回调（ADR-64）。
- **框架不运行任何调用方代码**（ADR-64 的终点，ADR-74）：提交边界只做参数准备（复制／值域／编码），没有
  `validate` 这类准入回调；业务准入由调用方在 `submit` 之前自己判。参数准备的抛错在那里就地变成同步
  `rejected`（`vue.ts` 的 `submit` 包一层 `try`），既不进入核心，也不改变
  已定身份、声明与调度；框架自身不写诊断日志。交付回调随结果表删除（ADR-59），失败通知回调随失败进
  结果表删除（ADR-63），`cleanup` 这类释放回调也随 ADR-64 删除——页面的拆卸由适配层自己做。
- **适配层只有一个标志**：`released`（`onScopeDispose` 置位，释放后 `submit` 返回 `cancelled`、`refresh` 无副作用）。
  读取面不再有第二个标志——它只有**一个数** `lastReadAt`（上次读取时间；`null` ＝ 还没有读取过）。
  核心不认识它，也不认识任何页面计数器。
  **走过的路（记下来免得回头）**：ADR-70／ADR-71 用「这一页点过一次刷新、还没看到那一拍」这个位当读闸门第二项，
  并两次判定它删不掉；ADR-72 把「还没有读取时间」与「点过刷新」合成同一件事（都是「没有时间就直接读」）之后，
  位就不需要了——代价是那条口径变化（还没读到过的暂停页会跟着第一份数据上屏一次，§6.2）。
- **读闸门在适配层**：核心不再回答「谁该跟随结果表」，只提供 `isEligible` 一个只读判定（这一页有没有取数资格）。适配层自己算
  `core.isEligible(config, url, key) || (lastReadAt === null && !document.hidden)`，
  据此决定两个出口跟不跟随这一拍（ADR-66、ADR-72、ADR-77、ADR-87）。**第二项只问「还没有读取时间」**：环境（激活、配置有效、
  可见）在 `refresh` 的入口闸那一刻已经判过，之后失活仍允许它更新那一帧（§6.2 的角落）。失败出口与数据出口共用这一个
  闸门，但**没有窗口**：失败不进画面只有一个原因——这一页此刻不是读者。
- 因此失败**没有**需要隔离的通知面，也**不是回调**（ADR-64 不变）：它和结果住同一格，只是走**另一个只读出口**
  （`failure`，ADR-77）；读者的反应仍然发生在各自的副作用里。
- 唯一 catch 不到的一类：传输拿到的 `AbortSignal` 上的监听器由宿主在 `abort()` 时同步调用，
  它们的抛错由宿主上报，因此不在承诺内。
- 后台失败保留声明与开启意愿，旧结果不变，下个周期继续；框架不改写调用方的 `enabled`。

## 7. 顺序约束

1. **换身份三步有序：扫描 → 摘旧 → 挂新。** `resourceOf` 先定位当前登记，再把这份配置从旧实例的 `declarers` 摘掉（旧实例若没人声明了就就地回收），最后挂到 `resourceFor` 给出的实例上。
2. **先让内部关系完整失效，再产生外部效果。** `undeclare` 先摘声明，再由 `releaseIfUnused` 删结果、abort；`dispose` 先清各实例的 `declarers`，再逐个回收。
3. **外部效果之后复核身份。** `await`、复制结果、写进结果表之前都要重新判断归属。
4. **旧清理只清自己。** 旧执行的 `finally` 只移除自己的槽位成员。
5. **资格判断无副作用。** `RefreshCore.isEligible` / `isVisible`、`Resource.dueAt` 与 `Resource.isEligible` 只读事实。
6. **槽位只在一种情况下释放。** 真实结束释放自己的槽位；abort 与回收都不提前交还。
7. **配置槽只有一个写入者。** 适配层把三个值交给核心的 `setConfig`，由它在一个同步块里写完并重排；别处只读。

## 8. 验证

`pnpm typecheck` → `pnpm test` → `pnpm check:docs` → `pnpm build` → `pnpm build:demo` → `pnpm test:browser`；
`pnpm complexity` 输出每文件与函数的行数、结构分支、圈复杂度和嵌套深度。
实际执行环境与已通过项见 [README](./README.md)「实际验证与边界」。
测试预期属于契约，修正测试前先确认契约。

## 9. 读这个库的顺序

本节是读代码的入口，替代「先通读注释」：**代码里的注释只写「做什么」，理由在本文与 [ADR.md](./ADR.md) 里。**
先按 §9.1 选一个进入点，记住 §9.2 的七个词，用 §9.3 查符号，遇到 `if` 用 §9.4 对照。

### 9.1 三条进入路线

| 你想弄清 | 从这里开始 | 接着读 |
|---|---|---|
| 一次取数怎么走完 | `src/index.ts`（两个导出）→ `vue.ts` 的 `useRefresh` | §2.1 的链路，再看 `RefreshCore.submit` → `flush` → `run` → `Resource.settle`（记结算时刻与 `produced`） |
| 一个页面的配置槽怎么变成共享实例 | `RefreshCore.submit` → `RefreshCore.resourceOf`（扫描）→ `RefreshCore.resourceFor` | §3.1 对象关系、§3.3 所有权表、§3.5 第 8／10 条 |
| 隐藏、卸载、销毁之后还剩什么 | `RefreshCore.setVisible` / `RefreshCore.undeclare` / `RefreshCore.dispose`；适配层的 `released` / `lastReadAt` | §3.6 命令表、§3.9 第一／二条、§3.5 第 9 条、§6.4 |

### 9.2 读代码前先记住的七个词

| 词 | 一句话含义 | 谁保证它 |
|---|---|---|
| 配置槽 | 每一页在核心里的登记：`{ enabled, every, active }` 一个对象，适配层原地改写；**`every === null` ＝ 这一拍配置非法** | 核心的 `setConfig`（唯一写入口，适配层给三个值）；别处只读（§3.3） |
| 声明 | 这一页的配置槽挂在某个实例的 `declarers` 里；挂载期间一直算，暂停/失活/隐藏都不撤销 | `submit` 登记、`undeclare` 撤销（§3.5 第 1 条） |
| 取数资格 | 声明还在 ＋ 这一页激活 ＋ 浏览器可见 ＋ 配置开启且有周期，四组缺一不可；**只决定要不要取数** | `Resource.isEligible`（§3.5 第 11 条） |
| 当前执行 | 一个实例至多一个执行，它至多在队列或在执行之一；`controller === null` 同时表示没有执行与这次不算数 | `enqueue` 建把手与 `dequeue` 摘出（`enqueueDue` / `refresh`）／`startQueued` 起跑／`run` 的收尾与 `releaseIfUnused` 清回 `null` |
| 刷新命令 | 一次显式刷新＝**给身份下的一句命令**：没有执行就插到队头；有执行且结果还没产出就用这一轮；结果已经写进表就记「还欠一轮」。**核心不记是谁点的**，同一轮内点几次合并成一次，没有回执 | `RefreshCore.refresh`（三条分支）、`Resource.produced` / `needsNext`、核心私有的 `enqueue`（插到队头）与收尾时的补一轮 |
| 结果表 | 结果的唯一真值：`URL → 参数键 → ResultCell 四字段`；页面按**已声明身份**读它，读到的就是那一份对象 | `useRefreshStore`（`store.ts`）：核心直接调 `sink.write` / `sink.fail` 写、`releaseIfUnused` 删、`display`／`failure` 读 |
| 读者 | 本页此刻跟着结果表走：**有资格**，或还没有读取过且此刻浏览器可见（`lastReadAt === null && !document.hidden`）；不是读者就冻结画面。读者画面＝**写入驱动 ＋ 一个数 `lastReadAt`**（同一版不抄第二遍；新格距画面里那一版满一个本页 `every` 才换，一个窗口最多换一次） | **适配层的读闸门**：`core.isEligible(...) || (lastReadAt === null && !document.hidden)`（§6.4；核心不认识这个判定） |

### 9.3 每个符号做什么

| 符号 | 做什么 |
|---|---|
| `Config` | 一页在核心里的**全部内容**与登记：`{ enabled, every, active }` 一个可变对象，适配层原地写、核心只读；`every === null` ＝ 这一拍配置非法 |
| `useRefresh` | 组件侧**唯一入口**：`(url, options)`——第一个参数是资源 URL 字符串（非空，空 URL 抛 `TypeError`），`P`／`T` 写在这一行的类型参数上；建立本页的配置槽并跟踪配置与生命周期，返回公开的 `RefreshHandle`（指向结果表的只读显示面与两个动作）；**参数准备在这里完成**（不跑任何调用方回调，ADR-74），抛错就地变 `rejected`（ADR-64）；`display`（数据出口）＝**写入驱动 ＋ `updatedAt` 差节流**（新格距展示中那份满一个本页 `every` 才换画面，一个 `every` 窗口最多换一次），**三处不等窗口**：身份落定、重新成为读者、显式 `refresh()`——都只把上次读取时间置 `null`；`failure`（失败出口）＝同一格里最近一次失败，**不参与窗口**、换一笔就发布、成功后 `null`（ADR-67、ADR-72、ADR-77） |
| `createRefreshManager` | 创建应用级协调者：接结果表（`pinia`）、取数实例（`axios`）与并发上限；`install` 再接可见性监听与卸载释放 |
| `RefreshFailure` | 失败出口的形状：`{ error, failedAt }`；`null` ＝ 自最后一次成功以来没失败过（含从未失败过）——「有没有失败」只看它在不在（ADR-77） |
| `handle.failure` | 本页看到的最近一次失败：与 `display` 同一个来源、同一个读闸门，但**不参与数据窗口**；写入时立刻发布，成功后清回 `null`（ADR-77） |
| `RefreshCore.isDisposed` | 协调者是否已销毁；存活状态的唯一公开出口 |
| `RefreshCore.undeclare` | 撤销一页的声明（组件卸载、销毁收尾）：把它摘出 `declarers`，没有声明者时就地回收 |
| `RefreshCore.isEligible` | 这一页此刻有没有取数资格（在该身份实例上现算）；核心只回答这一问，不回答「谁该跟随」 |
| `RefreshCore.setConfig` | 写这一页的配置槽（三个值非法只把 `every` 置 `null`）并重算一次到期与唤醒 |
| `RefreshCore.submit` | 声明或更新身份：`resourceOf` 扫描 → 摘旧 → 挂新；相同身份幂等；参数已由适配层在提交边界准备好再交进来（ADR-64） |
| `RefreshCore.refresh` | 给身份下一句「现在再取一次」；返回「这句命令收下了没有」（不是取数回执）——没有执行就插到队头，有执行且结果没产出就用这一轮，结果已经写进表就记「还欠一轮」（ADR-70） |
| 观测投影（`snapshot`） | 只读计数投影（四个字段：`resources` / `results` / `queued` / `running`），给演示面板、基准脚本与测试看；不属于包契约，ADR-79 起住在开发侧支撑模块 `scripts/observe.ts`，不在核心 |
| `RefreshCore.dispose` | 销毁：幂等、不可复用；先清每个实例的 `declarers`，再逐个回收 |
| `RefreshCore.resourceOf` / `releaseIfUnused` / `enqueue` / `dequeue` / `enqueueDue` / `startQueued` / `run`（全部私有） | 扫描定位配置槽登记在哪个实例／回收实例（`declarers` 空，并把欠的一轮与这次执行的认人一起作废）／排进队尾或插到队头（手动刷新与补的那一轮排在到期取数前面）／从队里摘掉／到期入队并收齐最早到期时刻／按队列顺序占槽启动／执行一次取数（两个结局都经核心各写一次结果表；实例不持有核心（ADR-65、ADR-70） |
| `RefreshCore.flush`（私有） | 一次合并调度：`clearWakeup`（取消旧 Timer）→ `enqueueDue`（到期入队并收齐最早到期时刻）→ `startQueued`（按队列顺序占槽启动）→ 队列空了就安排唯一唤醒 Timer |
| `Resource.dueAt` / `eligibleEvery` / `isPresent` / `isEligible` | 下次到期时刻／有资格声明者里的最小间隔／环境允不允许（激活且可见且配置有效）／单个声明者有没有资格；都现算，不缓存。**`isPresent` 与 `isEligible` 由核心问它**（`refresh` 的入口闸、调度与读闸门），另两个留在实例内部 |
| `Resource.settle` | 一次执行的两种结局都走它：只记结算时刻并把「这一轮已经产出」置起（失败也算结算，因此不自动重试）；写成功那一格、写失败那一格与回收都在核心 |
| `prepareParameters` | 提交边界只执行一次：复制 → 值域检查 → 编码身份键（不跑任何回调，ADR-74） |
| `useRefreshStore` | 结果表本身：`write` / `fail` / `remove` / `list`（内核写入端）与 `read`（页面读出口）；模块级定义，一个 Pinia 一张表 |

### 9.4 遇到 `if` 时按什么读

`core.ts` 里的守卫不是重复代码。它们防的是下面这几种，读之前先认出是哪一种：

| 防什么 | 长相（具名判定，ADR-69） | 作用 |
|---|---|---|
| 已销毁 / 已释放 | 入口第一行的 `this.disposed`；适配层自己的 `released`（`onScopeDispose` 置位：`submit` 返回 `cancelled`、`refresh` 无副作用） | 销毁或释放之后任何入口都不再产生事实（§2.4「取消只有一个来源」） |
| 身份不成立 | 按 URL ＋ key 查注册表返回 `undefined`（＝这个身份没声明过，或已经回收）；`resourceOf(config)` 返回 `undefined` | 没有身份时命令直接丢掉、不发请求、不判资格 |
| 这次执行已不是当前执行 | `!resource.isCurrent(controller)` | 每个 `await` 与每次外部效果之后：丢弃迟到的结束与迟到的异常，不写结果、不动结果表 |
| 这个身份还有没有执行 / 还有没有人声明 | `resource.hasExecution()`、`resource.isWanted()` | 有执行就不重复入队（A08）、不补一轮；没有声明者（`declarers` 空）才回收（G4） |
| 写表那一刻的同步重入 | **不是 `if` 而是顺序**：`settle` 先记结算时刻并把 `produced` 置起 → 核心写表 → `run` 的 `finally` 清 `produced` 并按 `needsNext` 插到队头补一轮（这一句命令落在哪条分支，由 `refresh` 里的 `hasExecution()` 与 `produced` 判） | 页面在 watcher 里当场 `refresh()` 时，那句命令落在**下一轮**（写表那一刻 `produced` 已经为真），不会被这一轮吃掉（§3.9 第一条） |

**这些守卫是承重的，不是冗余**；能叫出名字的都叫了名字，读的时候不必自己反推「这个 `if` 防的是哪一件」。
核心**不再有名册**（ADR-66）：一页是否已释放是适配层 `released` 的事实，`isDisposed` 才是核心自己的事实；
`submit` / `refresh` / `isEligible` 都按 URL ＋ key 现查注册表，因此不存在「名册与实例两侧一致」这类需要复核的状态。
