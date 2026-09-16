# Vue SPA 统一刷新管理

已实现 11 个运行时模块，以及正式包入口、类型声明和可运行示例。源码共用同一套参数准备、任务身份、取消和数据复制规则；没有占位成功路径。实现完成不等于验收表129项的所有分支、业务接入或发布基线已经完成。

## 从总体到局部

固定资源定义（interface、load、可选validate） → 提交边界准备Parameters → Manager执行 → Store与页面分别交付。

```text
src/public-types.ts   公共类型唯一代码定义
src/diagnostics.ts    诊断出口与返回值观察（零依赖叶子）
src/model.ts          内部模型：Handle / activity / Submission / Resource / Task / 端口
src/source.ts         固定资源定义、参数准备与稳定键、只读定位
src/delivery.ts       结果复制、observer 诊断、onError 通知隔离
src/store.ts          Pinia 结果分区适配
src/scheduler.ts      后台调度：唯一 Timer、FIFO 队列与并发槽位
src/vue.ts            组件适配：配置快照读取、句柄、配置 watcher、生命周期、Display
src/app.ts            应用安装、浏览器可见性、只读快照、销毁
src/manager.ts        Manager：页面操作、资源关系、后台执行、调度入口、释放
src/index.ts          包入口（只导出三个正式函数与公共类型）
```

- 依赖方向单向：`public-types`/`diagnostics` ← `source`/`model`/`delivery` ← `store`/`scheduler` ← `manager` ← `vue`/`app`。
  运行期边必须严格向下；唯一被登记的等层边是 `vue.ts → app.ts`（组件适配只需安装器提供的注入键），由 `pnpm check:docs` 与 [DESIGN.md](./DESIGN.md) §1 双向核对。
- 核心不依赖 Vue、Pinia 或 HTTP。
- 核心有两个文件：`manager.ts` 按职责分成八个分段：状态观测、页面操作、需求关系、后台执行、刷新要求、调度入口、有效性与身份、释放；
  唯一的 Timer、FIFO 队列与并发槽位归 `scheduler.ts`，它只通过端口回调取「谁该被登记、怎么执行」。
- 稳定键使用 [fast-json-stable-stringify](https://github.com/epoberezkin/fast-json-stable-stringify) 2.1.0；
  不引入 Zod、队列库或整套查询库——业务 schema 由应用自行选择，后台槽位与取消语义由一个调度器负责。
  选它是因为稳定编码自己写要同时覆盖键排序、数组保序与 JSON 转义边界；框架只借它做规范化编码，值域、深度与冻结仍由 `checkJsonValue` 先行完成，因此它不引入 schema 或校验语义。

先读[统一文档](./统一刷新管理.md)的「名词解释」「目标与范围」「公共 API 契约」「行为规则」四节；
设计与实现在 [DESIGN.md](./DESIGN.md)，验收目录在统一文档 §4。

## 参数怎样定义

每个 Source 固定自己的业务 interface。Resource 是“该 Source＋一组完整参数值”的运行实例，业务不用声明或操作 Resource。

```ts
interface QuoteParams {
  account: string
  symbol: string
}
interface Quote { price: number }

const source = defineRefresh<QuoteParams, Quote>({
  validate: p => p.account.length > 0 && p.symbol.length > 0,
  load: (params, { signal }) => quoteService.read(params, signal),
})
const task = useRefresh(source, { enabled, every: 2000 })
task.submit({ account: 'demo', symbol: 'DEMO' })
// 显式刷新当前已声明的身份：与自动刷新共用同一条获取与交付路径。
await task.refresh()
```

源码入口：[src/index.ts](./src/index.ts)。业务参数类型不要求继承通用字典，也不需要字符串索引签名。缺少必填字段、字段类型错误、DTO类型错误会被类型检查拒绝。外部unknown在应用入口校验，资源的同步validate检查业务条件；validate不再属于useRefresh options；TypeScript interface 不会生成运行时 schema。

- 参数根是普通对象，允许嵌套普通对象和数组；可选字段不用时省略，不能显式传 undefined。
- 参数要传**普通对象**：Vue 的 `reactive()` / `ref().value` 是 Proxy，提交边界的 `structuredClone` 会抛 `DataCloneError`，这类值会被按 `validation` 拒绝且不产生请求；需要时传 `toRaw(…)`、或自己新构造的普通对象。
- Source 身份及全部参数字段值决定共享；对象字段顺序不影响共享，数组顺序影响共享。不提供另一个业务 key 回调。
- 参数复制后深冻结；调用方原对象不冻结。框架的 load、刷新与 validate 使用受保护的参数副本。
- 参数是应用构造的JSON记录；框架不再提供任意对象描述符、原型、跨realm与特殊对象逐类防御。只保留 JSON 值域与循环守卫（根容器记 1，命中即按非法参数拒绝）。
- DTO业务结构由HTTP适配器校验，框架只拒绝undefined并使用structuredClone建立所有权；各页面与Store各自拥有副本。不再通用检查DTO原型/循环/字段描述符。
- readSnapshot仅计算身份，不复制冻结参数或运行validate。提交时prepare一次，轮询和恢复复用其结果。只有该来源仍有活跃共享实例（订阅或未结算的刷新要求）时才查得到分区，参数非法时抛错给读取者。

## 安装与使用

```ts
const pinia = createPinia()
const refresh = createRefreshManager({
  pinia,
  maxConcurrent: applicationConfig.refreshConcurrency,
})
app.use(pinia)
app.use(refresh)
if (import.meta.hot) import.meta.hot.dispose(() => refresh.dispose())
```

参数键是完整参数值的稳定编码；守卫边界与拒绝规则见统一文档 §3（U24）。业务侧规模结论与依据见统一文档 §5 G01。

每个组件在同步 setup 中调用 useRefresh；enabled/every/visible 都支持值、Ref或getter，整个 options 同样支持值、Ref或getter（`RefreshInput<RefreshOptions>`，传 Ref 时替换 options.value 即按新对象重新协调），框架只读它们、从不写入。只监听这些配置，不监听参数或表单。every 只在 enabled 为真时必需：只手动刷新的页面可以整个省略它，开启而省略按配置非法拒绝。submit 同步声明身份（同参重复声明幂等）；refresh 返回 success/error/cancelled，取消立即结算，且不携带 DTO。暂停后仍能刷新一次；true→false 的关闭边沿结算当时未完成的刷新要求。显式刷新与自动刷新共用同一队列与并发槽，满槽时排队；后台只在真实 load 结束后释放并发槽，另有一层框架上限（10 秒，从开始执行起算）到期即按共享请求失败结算并立即出册，因此永不结束的请求不会让应用停摆。

刷新失败会走两条通道：返回的 Promise 结算 `error`（`origin` 为 `request` 或 `configuration`），同时 `onError` 收到同一次失败；两条通道分别是给调用方控制流和统一错误出口的，页面若两处都提示需自行去重。错误通知还带产生它的声明代次（一个页面里两处 useRefresh 共用同一个 onError 时据此认领）。校验失败、共享请求失败各自也只会各报一次。**框架不改写调用方的 enabled**：失败后是否停止自动刷新由页面在 `onError` 里自己决定（写 `enabled=false` 即走正常关闭路径）；只要 enabled 仍为真，下个周期继续，暂停页也仍可主动刷新。

框架只有一条取数通道：显式刷新与自动刷新都经 Source.load，结果写入共享分区并交付给**有效订阅与满足门槛的刷新要求**（同一句柄只交付一次）。暂停页刷新一次时只有它自己与其他有效订阅收到更新，刷新不恢复自动订阅。display 是唯一交付面：args/data/origin 与 updatedAt（结果产生的墙钟毫秒）同次整体发布，后加入的组件读到已有结果时拿到的仍是原结果时间，可据此显示数据多旧；框架不交付「正在刷新」这类实时状态，失败走 onError。需要按结果写业务 Store 的页面在自己的适配层完成，框架不再提供受保护的同步提交入口。只读共享结果使用 refresh.readSnapshot(source, params)，它只交付值、不承诺新鲜度，不会创建资源或延长生命周期；要判断数据新旧就用 display（订阅会建立 Resource）。dispose 幂等；卸载自动清理，SSR不发请求。

## 运行

当前验证环境使用Node24；测试直接运行可擦除类型的TypeScript，不再启用实验性类型转换。依赖版本由锁文件固定：

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm build:demo
pnpm test:browser
pnpm complexity       # 每文件与函数的行数、分支、圈复杂度、嵌套；加 --write 回写下面的度量行
pnpm check:docs
pnpm dev
```

build 生成 dist/index.js 和类型声明，Vue/Pinia 是外部 peer dependencies；包仅导出 defineRefresh、createRefreshManager、useRefresh 及公共类型。build:demo 生成演示页面，HTTP fixture只由开发服务提供，不能把静态演示构建当作后端服务。

默认示例在 http://127.0.0.1:4173/，验证页为 /tests/browser.html；端口被占用时用 `pnpm dev --port 4177`。验证页会重置本地合成 HTTP 状态并在运行时关闭其他示例页，页面中可修改品种、查询本页、暂停和恢复。

pnpm test:browser 在独立4174端口用 Playwright 执行与验证页相同的八条场景；默认使用系统 Chrome（`channel: 'chrome'`），也可用 `PW_CHANNEL=bundled` 走随包 Chromium。同一批场景也能在验证页点击“运行六条集成场景”手工复核。

需要 Node 24（测试直接运行可擦除类型的 TypeScript）与 pnpm 11。无需额外 PATH 配置。

## 实际验证与边界

本次环境：Linux x86_64、Node24.20.0、pnpm11.24.0、Vue3.5.42、Pinia4.0.3、TypeScript7.0.2、Vite8.3.0、Playwright1.63.0（系统 Chrome）。只验证当前安装组合，不声明其他版本支持。

| 实际检查 | 结果/范围 |
|---|---|
| 依赖安装 | 清理 1999 个 macOS AppleDouble（`._*`）、2 个 `.DS_Store` 与 198MB 的 mac-arm64 浏览器缓存后，`pnpm install` 从 registry 重装成功；锁文件未被改写，`node_modules` 内无 `XSym` 占位文件 |
| pnpm typecheck | 通过。重装取得 linux-x64 原生编译器后 `tsc --noEmit` 可运行；`tests/types.ts` 的全部 `@ts-expect-error` 反例（缺字段/字段类型/旧元组调用/Source 不变性/DTO/readonly/refresh 不接受参数且结算不含 DTO）一并被校验 |
| tests/core.test.ts、tests/vue.test.ts | 69 个现行契约自动测试通过；含真实 Vue/KeepAlive/Pinia 和两个 SSR 渲染。定制渲染器测试不冒充真实浏览器可见性测试 |
| pnpm build | 通过。生成 `dist/index.js`（22.33 kB / gzip 6.81 kB）与类型声明（构建后处理改写说明符为 `.js`，并断言产物形态）；按包导入仅得到 defineRefresh、createRefreshManager、useRefresh 三个函数 |
| pnpm build:demo | 通过。生成 `dist-demo/` 演示页面（四个视图：查询列表、行情面板、双组件共享、B09 组合；`/?page=` 选择初始视图，`/?test`、`/?mode=controlled` 仍进入集成验证台） |
| tests/refresh.spec.ts（Playwright） | 需求重写后重跑：真实 Chrome 八条全部通过——暂停后显式刷新（同一条共享路径、不恢复自动刷新）、刷新与自动刷新共用队列（满槽排队、不绕过上限）、真实 HTTP 共享/恢复、真实传输超时（客户端截止生效、槽位释放、页面收到失败）、真实浏览器下祖先 KeepAlive 失活与受控 `visibilitychange`（L07.02＋监听路径）、旧响应隔离、真实结束放槽、卸载清理 |
| tests/pages.spec.ts（Playwright） | 需求重写后重跑：真实 Chrome 四条代表页面交互全部通过——查询列表（提交才发请求、分页排序复用已提交参数、独立启停、暂停仍可单查、失败关闭）、行情面板（无查询按钮、一次提交、响应式频率、显示数据多旧、后台首查失败继续、失活冻结）、双组件共享（1s/5s 同参共享、单页暂停、重新进入交付已有结果、切换品种、全部退订、Store 快照隔离）、B09（无启停按钮，前次失败后在 runner 内开启意愿且不先请求旧参数）。三条页面不手写 Timer，也不保存旧参数或操作版本 |
| 连续事件 | seed=42，3句柄、3参数值、300步；检查归属、队列、并发槽及进展，是有限探索 |
| pnpm complexity | 11 个源文件、1874 行、137 个结构分支、最大函数圈复杂度 8 |
| node scripts/benchmark.mjs（阶段 14 基线） | 24 订阅 / 8 身份 / every=25ms / maxConcurrent=4，3 次 × 2s：load 624 次（**收敛比 0.97**；按订阅计的反事实 1920 次）、真实在途峰值 **4**（框架 `running` 投影峰值同为 4，未超上限；本基线的 `load` 只让出一个微任务，没有任务触达 10 秒上限，因此「在册」与「真实在途」在此一致）、结束瞬间 8 个 Resource / 24 个句柄、**释放后残留全 0**；事件循环延迟 mean 1.08ms / p99 1.56ms / max 6.61ms（1ms 分辨率）。两个独立进程复跑给出相同的 load 624 与收敛比 0.97。规模可用 `--subscriptions/--identities/--duration/--every/--runs` 改；**不设性能阈值**，只在真实在途超过 `maxConcurrent` 或释放后有残留时以非零码退出。测量走公开入口与真实 Vue/Pinia，但 `load` 只让出一个微任务，**不含浏览器渲染与真实网络** |
| 阶段 15 交付产物 | `pnpm build` + `pnpm pack` 生成 `vue-refresh-0.0.0.tgz`：15 个条目 = `dist/` 13 个（`index.js` 22.33 kB / gzip 6.81 kB、sourcemap、11 个 `.d.ts`）+ `package.json` + README，无 `.ts` 说明符、无 `export type *`。连跑两次 `build`+`pack` 产物逐字节相同，包由已推送的源码构建（README 自身被打进包内，因此包的字节数随本文档变化，尺寸与哈希不写在这里）。**最终包 SHA-256 记在[统一文档](./统一刷新管理.md) §5 的 G04 行与交付提交信息里，不写在这里**——README 由 npm 强制打进包内（`files` 只列 `dist` 也会带上它），把包自身哈希写进包内文件在数学上不存在解 |
| 包级导入（干净消费方） | 在仓库外新建消费工程，`npm install <tarball> vue@3.5.42 pinia@4.0.3`（另需 Pinia 的非可选 peer `@vue/devtools-api@8.2.1`），只用包导出的三个函数：SSR 渲染成功且 0 次 `load`、`dispose` 后无残留私有 Store；最小浏览器环境（`document.hidden=false`）下挂载 + `submit` 交付 `origin=background`、`readSnapshot` 可读。**换包必删消费方的 `package-lock.json`**：`file:` 依赖的完整性写在锁文件里，不删会复用上一版解包内容而给出假通过 |
| TS 4.9 类型消费（G03 阻断节点） | 实测：`typescript@4.9.5` + `module/moduleResolution: Node16` 下消费该包，**本包 11 个声明文件与 Pinia 4.0.3 均零错误**；不加 `skipLibCheck` 时有 6 处错误，全部来自 `vue@3.5.42` 自身的 `.d.ts`（需要 `NoInfer` / `ToggleEvent`，TS ≥5.4），本包与 Pinia 无一处。安装侧：`pinia@4.0.3` 声明 `peerOptional typescript>=5.6.0`，TS 4.9 消费方必须 `--legacy-peer-deps`。因此「TS 4.9 + 最新 Vue/Pinia」可复现，但**必须**加 `skipLibCheck: true` 并跳过该 peer 校验。**2026-09-16 确认人裁决**：声明只限定到本包自身的类型（自 TS 4.9 起可用，已实测），Vue / Pinia 的 TS 下限以它们自己的 peer 声明为准，本包不替它们承诺 |
| pnpm check:docs | 通过。13 项一致性门禁，清单与各项动机以 `scripts/check-docs.mjs` 的自述注释为准；统一文档就在仓库根目录。`pnpm check:docs` 还会打印叶子→测试标题的可追溯性报告（见下） |

测试名称关联原验收ID，仅证明具体断言覆盖的分支，不把同ID的所有变体自动标通过。参数/DTO测试覆盖JSON键域与原生复制所有权；核心测试覆盖声明幂等/刷新合并/等待者结算、FIFO/真实结束放槽、重入、错误隔离（含晚到拒绝、已拒绝 Promise 与跨 realm thenable 三条定向故障注入）、序号到达上界后停在原地（不销毁 Manager、不写诊断）；Vue测试覆盖安装、配置异常/边沿、KeepAlive、Pinia同步通知和SSR；代表页面测试按页面走真实点击，覆盖 B09。`pnpm check:docs` 的 `[trace]` 行给出这层追溯的机器读数（§7 13.1 的逐 ID 证据账就在 `scripts/trace-leaves.mjs` 顶部）：129 个叶子里 **96 个被测试标题点名**，另有 30 个在 `EVIDENCE` 表中登记了真正判定它的测试（如 `P03/…` 那条覆盖 B12b/B13b/F01/M07/R07/S04/T08/T13），2 个的证据不在测试里（S09 类型检查、M10 包级导入与清单核对），合计 `已验证` 128；`部分验证` 1（F13：算法计数断言），缺口写在脚本表里；**`未验证` 0** —— `Q12`、`S02`、`A04` 随独立查询通道与 `commit` 的删除整体移出，编号留空不复用。未被点名不等于未被断言，只表示这条叶子没有以自己编号命名的测试。`node scripts/trace-leaves.mjs --map` 再往下打一层：按能力域列出它承载的 `U` 锚点与判定这些锚点的叶子，未被点名的叶子带 `!` 后缀——§3 的 `判定：` 是能力域级的（这是 A1-01 合并后的事实），所以锚点到叶子只能解析到域。

尚未取得的证据：`部分验证` 仅剩 F13 一项（「每次资源扫描只聚合一次、计数随订阅线性增长」缺少算法计数断言）、**真实切标签页**（浏览器真正把本页置为 hidden）与**监听已摘除本身**（需要 CDP 的 `DOMDebugger.getEventListeners`，当前驱动拿不到；只能在真实浏览器里以「卸载后再派发 `visibilitychange` 不产生任何请求」作为可观察边界）、真实业务接入，以及**真实设备与真实流量下的性能口径**——阶段 14 的基线只测框架侧代理量，`load` 只让出一个微任务，不含浏览器渲染与真实网络。版本范围按「TS 4.9 + 其余最新」声明，并已在 TS 4.9.5 下实测消费（结论与两个前置条件见上表）：本包与 Pinia 的类型零错误，Vue 3.5.42 自身的类型需要 `skipLibCheck`，安装需要跳过 Pinia 的 TS≥5.6 可选 peer。目标环境的真实安装与真实业务接入仍由接入方核验；规模与设备已确认（约 20+ 订阅、在途很少）。

正式文档为 `./统一刷新管理.md`（业务规则、契约、验收与门槛）、`./DESIGN.md`（设计与实现）与 `./ADR.md`（已裁决的产品边界与提案裁决）。
