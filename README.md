# Vue SPA 统一刷新管理

已实现 6 个运行时模块，以及正式包入口、类型声明和可运行示例。源码共用同一套参数准备、任务身份、取消与结果写入规则；
没有占位成功路径。结果是**结果表里的唯一真值**（按 URL → 参数键分组，落在你传入的 Pinia 实例上），页面按已声明身份读它；
运行期依赖只剩参数键的稳定编码，取数用的 axios 实例由 `createRefreshManager` 注入，库不 import 它。
实现完成不等于验收目录（[统一文档](./统一刷新管理.md) §4 的 A01–A20）的所有分支、业务接入或发布基线已经完成。

## 从总体到局部

固定资源定义（URL、interface、可选 validate） → 提交边界准备参数 → 共享实例执行 → 结果写进结果表 → 每个页面按身份读到同一个对象。

```text
src/public-types.ts   公共类型的唯一代码定义与状态取值常量
src/source.ts         固定资源定义（URL ＋ 参数准入）、参数准备与稳定键
src/core.ts           跨实例的协调者（注册表、句柄名册、队列与并发、调度）＋ 一个身份的 Resource 类
src/store.ts          结果表（Pinia）：每个 (URL, 参数键) 一份独立 ShallowRef，写一格只唤醒订阅这一格的 watcher；随实例释放把该格置 `undefined`
src/vue.ts            组件适配与安装：配置快照、句柄、生命周期、可见性、结果表接线
src/index.ts          包入口（三个函数与 6 个公共类型；没有常量对象）
```

- 依赖方向单向：`public-types` ← `source` ← `core` ← `store` ← `vue` ← `index`。
  运行期边必须严格向下；本版没有需要登记的等层边，由 `pnpm check:docs` 与 [DESIGN.md](./DESIGN.md) §1 双向核对。
- 核心不依赖 Vue／Pinia，也不 import HTTP 客户端（只要求注入的对象有一个 `post`）；`store.ts` 是唯一 import Pinia 的模块。`core.ts` 按职责分成七个分段：状态观测与生命周期、页面操作、观测面、需求关系、后台执行、刷新要求、调度。
- 全部可变状态都在 `core.ts`，按所属分三处：**跨实例的**挂在协调者上（`buckets` 身份 → 共享实例、`handles` 名册、`queue`/`running`、唯一唤醒 Timer），**一个身份自己的**在 `Resource` 类里（声明者、刷新要求、到期与当前任务），**结果**在结果表（`store.ts` 接 Pinia）。
  **声明与资格分开**：页面挂载期间一直声明着身份（暂停、失活、隐藏都不撤销），资格（开启 ＋ 激活 ＋ 浏览器可见）现算，只决定要不要取数。声明侧只有一处事实（实例的 `declarers` 成员资格），没有镜像字段。
- 参数稳定键交给 `fast-json-stable-stringify`（`JSON.stringify` 的确定性版本：对象键排序、数组保序），是运行期唯一的依赖；框架不设深度上限，业务字段是否合法由调用方负责。

先读[统一文档](./统一刷新管理.md)的「名词解释」「目标与范围」「公共 API 契约」「行为规则」四节；
设计与实现在 [DESIGN.md](./DESIGN.md)，验收目录在统一文档 §4。

## 参数怎样定义

每个 Source 固定自己的业务 interface。共享实例是「该 Source ＋ 一组完整参数值」的运行实例，业务不用声明或操作它。

```ts
interface QuoteParams {
  account: string
  symbol: string
}
interface Quote { price: number }

// 身份的一半是 URL，另一半是参数值：框架对 URL 发 `post(url, 参数值, { signal })`。
const source = defineRefresh<QuoteParams, Quote>('/api/quote', {
  validate: p => p.account.length > 0 && p.symbol.length > 0,
})
const task = useRefresh(source, { enabled, every: 2000 })
task.submit({ account: 'demo', symbol: 'DEMO' })
// 显式刷新当前已声明的身份：与自动刷新共用同一条获取与交付路径。
await task.refresh()
```

两项配置都是 `Ref`：改 `enabled.value` / `every.value` 就是改配置，框架立刻按新配置重新协调；
可运行的例子见 `examples/pages/shared-pair.ts`（「暂停本页」就是切 `options.enabled.value`）。

- 参数根是普通对象，允许嵌套普通对象与数组；可选字段不用时省略——显式传 `undefined` 会被按省略处理（与不传是同一个身份），推荐直接省略。嵌套字段请用 `type` 别名或内联对象字面量：具名 `interface` 没有隐式索引签名，会被声明点的值域约束打红（TS2344）。
- 参数要传**普通对象**：Vue 的 `reactive()` / `ref().value` 是 Proxy，提交边界的复制会抛 `DataCloneError`，
  这类值提交时按 `rejected` 拒绝且不产生请求；需要时传 `toRaw(…)` 或自己新构造的普通对象。
- URL 及全部参数字段值决定共享：**同一个 URL 在几处各写一份定义也照样合并**（身份不是对象引用），对象字段顺序不影响共享，数组顺序影响共享；不提供另一个业务 key 回调。
- 参数在提交边界复制成框架私有副本，调用方原对象不参与；`validate`、每一轮请求体与每个接收者的 `display` 各拿一份副本，因此谁改自己的都不影响别人。轮询、恢复与显式刷新复用同一份已准备参数，`validate` 只在提交时执行一次。
- **对象型参数只能是普通对象或数组**（ADR-52）：`Date`／`Map`／`Set`／`RegExp`／`ArrayBuffer` 这类内容对编码不可见的容器会让两个不同查询塌成同一个身份，故一律拒绝——`Date` 请传它的 ISO 字符串（声明点由 `defineRefresh` 的类型约束先报错，提交边界再由运行期检查兜底）。标量沿用 JSON 语义：`-0` 与 `0` 同键，`NaN`／`Infinity` 按 `null`，`undefined` 字段按省略；传函数、Proxy 这类复制不了的值由 `structuredClone` 拒绝，循环引用让编码交不出身份（内部是 `null`）。以上都按 `rejected` 拒绝（不走 `onError`）。业务字段的合法性仍由调用方与 `validate` 负责。
- DTO 业务结构由传输侧校验（示例里是 `demoHttp`，接入方通常是 axios 响应拦截器）；框架只拒绝 `undefined` 并在入站时原生复制一次建立所有权，之后所有读者共享同一份结果。畸形响应在框架看来是一次成功，会覆盖旧结果——要不要挡住它由传输侧决定。

## 安装与使用

```ts
// `axios` 是你配好 baseURL／拦截器／鉴权头的实例；框架只要求它有一个 `post`。
// `pinia` 就是你 `app.use()` 的那个实例——结果表挂在它上面。
const refresh = createRefreshManager({ maxConcurrent: applicationConfig.refreshConcurrency, axios, pinia })
app.use(refresh)
if (import.meta.hot) import.meta.hot.dispose(() => refresh.dispose())
```

每个组件在同步 setup 中调用 `useRefresh`，第二个参数格式固定：`enabled` 与 `every` **都是 `Ref`，且都必需**。
框架只读它们的 `.value`、从不写入；改任一项就按新配置重新协调（`computed` 也是 `Ref`，所以响应式组合不受影响）。
只监听这两项配置，不监听参数或表单。浏览器可见性由框架自己监听，调用方不再声明第二层可见条件。

`submit` 同步声明身份（同参重复声明幂等，参数被拒时不改动任何状态）；`refresh` 只登记一次要数、**没有回执**。
关闭 `enabled` 只退订、**不撤销**已发起的刷新要求，因此暂停页仍能刷新一次。
显式刷新与自动刷新共用同一队列与并发槽，满槽时排队；显式刷新与自动刷新共用同一队列与并发槽，满槽时排队；后台只在真实取数结束后释放并发槽，
另有一层框架上限（10 秒，从开始执行起算）到期即按共享请求失败结算并立即出册，因此挂死的请求不会让应用停摆。

刷新失败只走一条通道：`onError`（参数是原始异常，**只报共享请求失败**）——此刻的读者（有资格的页面，以及本次有刷新要求的页面）都会收到，
默认行为是不改写调用方的开关、下个周期继续。
**框架不改写调用方的 `enabled`**：失败后是否停止自动刷新由页面在 `onError` 里自己决定；
只要 `enabled` 仍为真，下个周期继续，暂停页也仍可主动刷新。

框架只有一条取数通道：显式刷新与自动刷新都由框架按 URL 取数，成功后把结果写进结果表（每个身份一条）。
`display` 是唯一读出口：它按**已声明身份**读 `args` / `data` / `updatedAt`（结果产生的墙钟毫秒），不提供「正在刷新」这类实时状态。
**读到的 `data` 就是结果表里那同一个对象**：同一身份的页面共享它，要改自己复制（编译期只读视图不算运行期隔离）；`args` 每次读取复制一份。
**只有读者才跟随**：本页还是该身份的读者（**有资格**——声明着它且开启且激活且浏览器可见——或它上面有未撤销的刷新要求）时才更新画面；暂停、失活、隐藏后**画面冻结在最后一帧**，但暂停页自己按一次「刷新」仍会更新（那一次它在要求里）——「暂停本页」演示的就是这条。
实例释放时条目随之删掉，所以「没有需求就没有结果」这条仍然成立。业务侧不需要再抄一份到自己的 Store——真值已经在 Pinia 里。
`dispose` 幂等；应用卸载自动清理。本库只服务 SPA，需要浏览器环境。

## 运行

当前验证环境使用 Node 24；测试直接运行可擦除类型的 TypeScript。依赖版本由锁文件固定：

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

`build` 生成 `dist/index.js` 与类型声明，Vue 是外部 peer dependency；包仅导出 `defineRefresh`、
`createRefreshManager`、`useRefresh`，以及 6 个公共类型（清单见统一文档 §2；工具型别名不导出，按推断使用）。这里没有常量对象：取值域直接写在判别联合里（ADR-51）。`build:demo` 生成演示页面，HTTP fixture 只由开发服务提供。

默认示例在 http://127.0.0.1:4173/，验证页为 `/tests/browser.html`；端口被占用时用 `pnpm dev --port 4177`。
`pnpm test:browser` 在独立 4174 端口用 Playwright 执行与验证页相同的场景；默认使用系统 Chrome
（`channel: 'chrome'`），也可用 `PW_CHANNEL=bundled` 走随包 Chromium。

需要 Node 24（测试直接运行可擦除类型的 TypeScript）与 pnpm 11，无需额外 PATH 配置。

## 实际验证与边界

本次环境：Linux x86_64、Node 24.20.0、pnpm 11.24.0、Vue 3.5.42、TypeScript 7.0.2、Vite 8.3.0、Playwright 1.63.0（系统 Chrome）。
只验证当前安装组合，不声明其他版本支持。

| 实际检查 | 结果/范围 |
|---|---|
| pnpm typecheck | 通过，0 错误。`tests/types.ts` 的 `@ts-expect-error` 反例（缺字段/字段类型/旧元组调用/Source 不变性/DTO/readonly/refresh 不接受参数且结算不含 DTO/参数值域拒绝 `Date` 与 `Map`）一并被校验 |
| pnpm test | 通过：41 个用例全绿（`tests/core.test.ts` 34、`tests/vue.test.ts` 7），覆盖 A01–A20。核心用例直接驱动 `RefreshCore` 并提供配置快照（含一条「运行期失败只走返回值或 `onError`」的边界总账）；Vue 用例用无 DOM 的自定义渲染器 ＋ 真实 KeepAlive，安装路径用最小 `document` 替身，不冒充真实可见性测试 |
| pnpm build | 通过。生成 `dist/index.js`（12.15 kB，12151 字节）与 6 个声明文件（构建后处理改写说明符为 `.js` 并断言产物形态；`vue` 与 `pinia` 都是外部依赖） |
| pnpm build:demo | 通过。生成 `dist-demo/` 演示页面（四个视图：查询列表、行情面板、双组件共享、B09 组合） |
| pnpm test:browser | 通过：真实 Chrome 12 条场景全绿——三条代表页面交互（`tests/pages.spec.ts`）＋ 八条受控场景（`tests/refresh.spec.ts`：暂停后显式刷新、满槽排队、真实 HTTP 共享与恢复、真实传输超时、旧响应晚到、真实结束放槽、卸载清理、祖先 KeepAlive 失活与受控 `visibilitychange`）。八条受控场景在根契约重写后**未改一行**仍然通过；页面交互用例只把行情面板的失败场景由 1 次加强为**连续 3 次**（验证反复失败不累积成崩溃），其余断言未动 |
| pnpm complexity | 6 个源文件、1076 行、94 个结构分支、最大函数圈复杂度 11 |
| node scripts/benchmark.mjs | 24 订阅 / 8 身份 / every=25ms / maxConcurrent=4，3 次 × 2s：取数中位 632 次（收敛比 0.99；按订阅计的反事实 1920 次）、在途峰值 4（框架 `running` 投影峰值同为 4，未超上限）、结束瞬间 8 个共享实例 / 24 个句柄、**释放后残留全 0**；事件循环延迟 mean 1.08ms / p99 1.44ms / max 6.04ms。规模可用 `--subscriptions/--identities/--duration/--every/--runs` 改；**不设性能阈值**，只在真实在途超过 `maxConcurrent` 或释放后有残留时以非零码退出 |
| 阶段 15 交付产物 | `pnpm build` ＋ `pnpm pack` 生成 `vue-refresh-0.0.0.tgz`：10 个条目 = `dist/` 8 个（`index.js` 12.15 kB，12151 字节、sourcemap、6 个 `.d.ts`）＋ `package.json` ＋ README。最终包 SHA-256 记在[统一文档](./统一刷新管理.md) §5 的 G04 行，不写在这里——README 由 npm 强制打进包内，把包自身哈希写进包内文件没有解 |
| 包级导入（干净消费方） | 仓库外消费工程安装 tarball ＋ `vue@3.5.42` ＋ `pinia` ＋ `axios`：对**真实 HTTP 服务**跑通 `submit` → 结果表 → 页面读到 `price=3`；运行期再断言导出面恰好是三个函数，且值域（ADR-52）兜底拒绝 `Map` 这类内容对编码不可见的容器参数（只经 `rejected`）。**换包必删消费方的 `package-lock.json`**：`file:` 依赖的完整性写在锁文件里，不删会复用上一版解包内容而给出假通过 |
| TS 4.9 类型消费（G03 阻断节点） | 实测：`typescript@4.9.5` ＋ `module/moduleResolution: Node16` ＋ `strict` ＋ `skipLibCheck` 下 `tsc --noEmit` **本包 6 个声明文件零错误**（含 `@ts-expect-error` 反例：缺字段、Source 不变性、`refresh` 不接受参数、取消分支不带 `reason`、参数值域的 `Date`／`Map`）；`pinia` 与 `axios` 的 `.d.ts` 由 `skipLibCheck` 跳过校验（它们各自的 TS 下限不由本包承诺）——注意 `pinia@4` 自己声明了可选 peer `typescript >= 5.6`，所以在 TS 4.9 工程里安装要用 `--legacy-peer-deps`（或 `overrides`），本包自身的 6 个声明文件仍按 TS 4.9 逐条校验。Vue 3.5.42 自身的 `.d.ts` 要求 TS ≥5.4，故 `skipLibCheck: true` 是前置条件。确认人 2026-09-16 裁决：声明只限定到本包自身的类型（自 TS 4.9 起可用，已实测） |
| pnpm check:docs | 通过。一致性门禁清单与各项动机以 `scripts/check-docs.mjs` 的自述注释为准；还会打印叶子→测试标题的追溯报告 |

测试名称以验收叶子编号开头（`A01`–`A20`），只证明具体断言覆盖的分支，不把同一叶子的全部变体自动标通过。
核心测试覆盖声明幂等与校验失败不改状态、共享身份、恢复与不补跑、并发上限与 FIFO、框架上限出册与迟到结束无效、
失败结算与下个周期继续、交付副本独立、参数值域与参数副本隔离、回调隔离、销毁、可见性切换的退订与恢复、
运行期失败只走返回值或 `onError`；
Vue 测试覆盖声明即取数、配置非法只通知一次并在修正后恢复、改 `enabled.value` 立即生效（暂停与恢复）、
KeepAlive 双向幂等、安装冲突与接管、未安装协调者时抛错。
`pnpm check:docs` 的 `[trace]` 行给出机器读数：19 个叶子全部由测试标题点名，`部分验证` 0、`未验证` 0。

尚未取得的证据：**真实切标签页**（浏览器真正把本页置为 hidden）与**监听已摘除本身**（需要 CDP 的
`DOMDebugger.getEventListeners`，当前驱动拿不到；只能在真实浏览器里以「卸载后再派发 `visibilitychange`
不产生任何请求」作为可观察边界）、真实业务接入，以及**真实设备与真实流量下的性能口径**——
基线只测框架侧代理量，取数只让出一个微任务，不含浏览器渲染与真实网络。

正式文档为 `./统一刷新管理.md`（业务规则、契约、验收与门槛）、`./DESIGN.md`（设计与实现）与 `./ADR.md`（已裁决的产品边界与提案裁决）。
