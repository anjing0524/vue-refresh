# Vue SPA 统一刷新管理

已实现 12 个运行时模块，以及正式包入口、类型声明和可运行示例。源码共用同一套参数准备、任务身份、取消和数据复制规则；没有占位成功路径。实现完成不等于验收表132项的所有分支、业务接入或发布基线已经完成。

## 从总体到局部

固定资源定义（interface、load、可选validate） → 提交边界准备Parameters → Manager执行 → Store与页面分别交付。

```text
src/public-types.ts   公共类型唯一代码定义
src/diagnostics.ts    诊断出口与返回值观察（零依赖叶子）
src/model.ts          内部模型：Handle / activity / Submission / Resource / Task / 端口
src/source.ts         固定资源定义、参数准备与稳定键、只读定位
src/delivery.ts       结果复制、observer 诊断、onError 通知隔离
src/query.ts          独立查询执行、commit 与结算
src/store.ts          Pinia 结果分区适配
src/scheduler.ts      后台调度：唯一 Timer、FIFO 队列与并发槽位
src/vue.ts            组件适配：配置快照读取、句柄、配置 watcher、生命周期、Display
src/app.ts            应用安装、浏览器可见性、只读快照、销毁
src/manager.ts        Manager：页面操作、资源关系、后台执行、调度入口、释放
src/index.ts          包入口（只导出三个正式函数与公共类型）
```

- 依赖方向单向：`public-types`/`diagnostics` ← `source`/`model`/`delivery` ← `query`/`store`/`scheduler` ← `manager` ← `vue`/`app`。
  运行期边必须严格向下；唯一被登记的等层边是 `vue.ts → app.ts`（组件适配只需安装器提供的注入键），由 `pnpm check:docs` 与 [DESIGN.md](./DESIGN.md) §1 双向核对。
- 核心不依赖 Vue、Pinia 或 HTTP。
- 核心有两个文件：`manager.ts` 按职责分成八个分段：状态观测、页面操作、需求关系、后台执行、调度入口、有效性与身份、释放、提交与交付要求；
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
await task.query({ account: 'demo', symbol: 'OTHER' }, async (params, context) => {
  return quoteService.read(params, context.signal)
})
```

源码入口：[src/index.ts](./src/index.ts)。业务参数类型不要求继承通用字典，也不需要字符串索引签名。缺少必填字段、字段类型错误、DTO类型错误会被类型检查拒绝。外部unknown在应用入口校验，资源的同步validate检查业务条件；validate不再属于useRefresh options；TypeScript interface 不会生成运行时 schema。

- 参数根是普通对象，允许嵌套普通对象和数组；可选字段不用时省略，不能显式传 undefined。
- 参数要传**普通对象**：Vue 的 `reactive()` / `ref().value` 是 Proxy，提交边界的 `structuredClone` 会抛 `DataCloneError`，这类值会被按 `validation` 拒绝且不产生请求；需要时传 `toRaw(…)`、或自己新构造的普通对象。
- Source 身份及全部参数字段值决定共享；对象字段顺序不影响共享，数组顺序影响共享。不提供另一个业务 key 回调。
- 参数复制后深冻结；调用方原对象不冻结。框架请求、query 和 validate 使用受保护的参数副本。
- 参数是应用构造的JSON记录；框架不再提供任意对象描述符、原型、跨realm与特殊对象逐类防御。只保留 JSON 值域与循环守卫（根容器记 1，命中即按非法参数拒绝）。
- DTO业务结构由HTTP适配器校验，框架只拒绝undefined并使用structuredClone建立所有权；各页面与Store各自拥有副本。不再通用检查DTO原型/循环/字段描述符。
- readSnapshot仅计算身份，不复制冻结参数或运行validate。提交时prepare一次，轮询和恢复复用其结果。

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

每个组件在同步 setup 中调用 useRefresh；enabled/every/visible 都支持值、Ref或getter，框架只读它们、从不写入。只监听这些配置，不监听参数或表单。submit 同步返回接纳结果；query 返回 success/error/cancelled，取消立即结算。暂停后仍能新发起单次 query；true→false 的关闭动作取消当时查询。后台只在真实 load 结束后释放并发槽。

query 失败会走两条通道：返回的 Promise 结算 `error`（带 `origin`），同时 `onError` 收到同一次失败的 `origin: 'execution'`；两条通道分别是给调用方控制流和统一错误出口的，页面若两处都提示需自行去重。校验失败、后台失败各自也只会各报一次。**框架不改写调用方的 enabled**：查询失败后是否停止轮询由页面在 `onError` 里自己决定（写 `enabled=false` 即走正常关闭路径）；只要 enabled 仍为真，失败的提交会由后台路径接管首查。

query 的 DTO 只发布本页，开启时再独立启动共享刷新。display 是唯一交付面：args/data/origin 与 updatedAt（结果产生的墙钟毫秒）同次整体发布，后加入的组件读到已有结果时拿到的仍是原结果时间，可据此显示数据多旧；框架不交付「正在刷新」这类实时状态，失败走 onError。额外异步业务写入须在等待后通过 context.commit 同步提交；不能把 async 函数传给 commit。只读共享结果使用 refresh.readSnapshot(source, params)，它只交付值、不承诺新鲜度，不会创建资源或延长生命周期；要判断数据新旧就用 display（订阅会建立 Resource）。dispose 幂等；卸载自动清理，SSR不发请求。

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

pnpm test:browser 在独立4174端口用 Playwright 执行与验证页相同的六条场景；默认使用系统 Chrome（`channel: 'chrome'`），也可用 `PW_CHANNEL=bundled` 走随包 Chromium。同一批场景也能在验证页点击“运行六条集成场景”手工复核。

需要 Node 24（测试直接运行可擦除类型的 TypeScript）与 pnpm 11。无需额外 PATH 配置。

## 实际验证与边界

本次环境：Linux x86_64、Node24.20.0、pnpm11.24.0、Vue3.5.42、Pinia4.0.3、TypeScript7.0.2、Vite8.3.0、Playwright1.63.0（系统 Chrome）。只验证当前安装组合，不声明其他版本支持。

| 实际检查 | 结果/范围 |
|---|---|
| 依赖安装 | 清理 1999 个 macOS AppleDouble（`._*`）、2 个 `.DS_Store` 与 198MB 的 mac-arm64 浏览器缓存后，`pnpm install` 从 registry 重装成功；锁文件未被改写，`node_modules` 内无 `XSym` 占位文件 |
| pnpm typecheck | 通过。重装取得 linux-x64 原生编译器后 `tsc --noEmit` 可运行；`tests/types.ts` 的全部 `@ts-expect-error` 反例（缺字段/字段类型/旧元组调用/Source 不变性/DTO/readonly/async commit）一并被校验 |
| tests/core.test.ts、tests/vue.test.ts | 42 个现行契约自动测试通过；含真实 Vue/KeepAlive/Pinia 和两个 SSR 渲染。定制渲染器测试不冒充真实浏览器可见性测试 |
| pnpm build | 通过。生成 `dist/index.js`（21.83 kB / gzip 6.75 kB）与类型声明（构建后处理改写说明符为 `.js`，并断言产物形态）；按包导入仅得到 defineRefresh、createRefreshManager、useRefresh 三个函数 |
| pnpm build:demo | 通过。生成 `dist-demo/` 演示页面（四个视图：查询列表、行情面板、双组件共享、B09 组合；`/?page=` 选择初始视图，`/?test`、`/?mode=controlled` 仍进入集成验证台） |
| tests/refresh.spec.ts（Playwright） | 真实 Chrome 六条全部通过：暂停单查、满槽独立查询及取消、真实 HTTP 共享/恢复、旧响应隔离、真实结束放槽、卸载清理 |
| tests/pages.spec.ts（Playwright） | 真实 Chrome 四条代表页面交互全部通过：查询列表（提交才发请求、分页排序复用已提交参数、独立启停、暂停仍可单查、失败关闭）、行情面板（无查询按钮、一次提交、响应式频率、显示数据多旧、后台首查失败继续、失活冻结）、双组件共享（1s/5s 同参共享、单页暂停、重新进入交付已有结果、切换品种、全部退订、Store 快照隔离）、B09（无启停按钮，前次失败后在 runner 内开启意愿且不先请求旧参数）。三条页面不手写 Timer，也不保存旧参数或操作版本 |
| 连续事件 | seed=42，3句柄、3参数值、300步；检查归属、队列、并发槽及进展，是有限探索 |
| pnpm complexity | 12 个源文件、1920 行、133 个结构分支、最大函数圈复杂度 8 |
| node scripts/benchmark.mjs（阶段 14 基线） | 24 订阅 / 8 身份 / every=25ms / maxConcurrent=4，3 次 × 2s：load 624 次（**收敛比 0.97**；按订阅计的反事实 1920 次）、真实在途峰值 **4**（框架 `running` 投影峰值同为 4，未超上限）、结束瞬间 8 个 Resource / 24 个句柄、**释放后残留全 0**；事件循环延迟 mean 1.08ms / p99 1.56ms / max 6.61ms（1ms 分辨率）。两个独立进程复跑给出相同的 load 624 与收敛比 0.97。规模可用 `--subscriptions/--identities/--duration/--every/--runs` 改；**不设性能阈值**，只在真实在途超过 `maxConcurrent` 或释放后有残留时以非零码退出。测量走公开入口与真实 Vue/Pinia，但 `load` 只让出一个微任务，**不含浏览器渲染与真实网络** |
| pnpm check:docs | 通过。12 项一致性门禁，清单与各项动机以 `scripts/check-docs.mjs` 的自述注释为准；统一文档就在仓库根目录。`pnpm check:docs` 还会打印叶子→测试标题的可追溯性报告（见下） |

测试名称关联原验收ID，仅证明具体断言覆盖的分支，不把同ID的所有变体自动标通过。参数/DTO测试覆盖JSON键域与原生复制所有权；核心测试覆盖query取消/commit/D01/barrier、FIFO/真实结束放槽、重入、错误隔离（含晚到拒绝、已拒绝 Promise 与跨 realm thenable 三条定向故障注入）、序号推到上界后的销毁路径；Vue测试覆盖安装、配置异常/边沿、KeepAlive、Pinia同步通知和SSR；代表页面测试按页面走真实点击，覆盖 B09。`pnpm check:docs` 的 `[trace]` 行给出这层追溯的机器读数：132 个叶子中 73 个被测试标题点名、59 个没有；未被点名不等于未被断言，只表示该叶子没有以自己编号命名的测试。`node scripts/trace-leaves.mjs --map` 再往下打一层：按能力域列出它承载的 `U` 锚点与判定这些锚点的叶子，未被点名的叶子带 `!` 后缀——§3 的 `判定：` 是能力域级的（这是 A1-01 合并后的事实），所以锚点到叶子只能解析到域。

尚未取得的证据：132项的全部分支核账（分支变体已内联在叶子行尾的 `变体：` 尾注里，没有独立索引表；`pnpm check:docs` 打印的追溯报告给出「测试标题未提及」的叶子清单，它不等于未测试）、真实浏览器下的祖先 KeepAlive 组合与 `visibilitychange` 组合、真实业务接入，以及**真实设备与真实流量下的性能口径**——阶段 14 的基线只测框架侧代理量，`load` 只让出一个微任务，不含浏览器渲染与真实网络。版本范围已按「TS 4.9 + 其余最新」声明：构建后处理已确保产物不使用 TS 5+ 语法、不保留 `.ts` 说明符，但**未在 TS 4.9 下实测消费**，目标环境核验由接入方完成；规模与设备已确认（约 20+ 订阅、在途很少）。

正式文档为 `./统一刷新管理.md`（业务规则、契约、验收与门槛）与 `./DESIGN.md`（设计与实现）。
