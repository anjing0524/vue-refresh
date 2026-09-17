# Vue SPA 统一刷新管理

已实现 5 个运行时模块，以及正式包入口、类型声明和可运行示例。源码共用同一套参数准备、任务身份、取消与结果复制规则；
没有占位成功路径，也没有第三方运行时依赖——框架不依赖应用的状态库。
实现完成不等于验收目录（[统一文档](./统一刷新管理.md) §4 的 A01–A18）的所有分支、业务接入或发布基线已经完成。

## 从总体到局部

固定资源定义（interface、load、可选 validate） → 提交边界准备参数 → 共享实例执行 → 每个页面一份独立副本。

```text
src/public-types.ts   公共类型的唯一代码定义与状态取值常量
src/source.ts         固定资源定义、参数准备与稳定键、只读定位
src/core.ts           全部运行时状态：共享实例、订阅、刷新要求、调度、交付与失败
src/vue.ts            组件适配与安装：配置快照、句柄、生命周期、可见性、只读入口
src/index.ts          包入口（三个函数、三个状态常量对象与 8 个公共类型）
```

- 依赖方向单向：`public-types` ← `source` ← `core` ← `vue` ← `index`。
  运行期边必须严格向下；本版没有需要登记的等层边，由 `pnpm check:docs` 与 [DESIGN.md](./DESIGN.md) §1 双向核对。
- 核心不依赖 Vue 或 HTTP。`core.ts` 按职责分成七个分段：状态观测与生命周期、页面操作、只读定位与观测面、需求关系、后台执行、刷新要求、调度。
- 全部可变状态都在 `core.ts`：`buckets`（身份 → 共享实例）、每个实例的订阅与刷新要求、当前任务与队列。
  订阅只写在句柄上、实例侧持有同一批句柄，刷新要求只写在实例上——没有镜像字段，也没有第二套描述同一关系的对象。
- 参数稳定键由 `source.ts` 自己编码（键排序、数组保序、值域与根容器守卫），因此没有第三方运行时依赖；不设深度上限，循环引用由引擎递归耗尽调用栈报 `RangeError`。

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

const source = defineRefresh<QuoteParams, Quote>({
  validate: p => p.account.length > 0 && p.symbol.length > 0,
  load: (params, { signal }) => quoteService.read(params, signal),
})
const task = useRefresh(source, { enabled, every: 2000 })
task.submit({ account: 'demo', symbol: 'DEMO' })
// 显式刷新当前已声明的身份：与自动刷新共用同一条获取与交付路径。
await task.refresh()
```

整段 `options` 也可以是它的 Ref / getter（`RefreshInput<RefreshOptions>`）：传给框架后，`options.value = next`
会让框架按新对象重新协调；可运行的例子见 `examples/pages/shared-pair.ts`（「暂停本页」用换对象而不是改字段）。

- 参数根是普通对象，允许嵌套普通对象与数组；可选字段不用时省略，不能显式传 `undefined`。
- 参数要传**普通对象**：Vue 的 `reactive()` / `ref().value` 是 Proxy，提交边界的复制会抛 `DataCloneError`，
  这类值按 `validation` 拒绝且不产生请求；需要时传 `toRaw(…)` 或自己新构造的普通对象。
- Source 身份及全部参数字段值决定共享：对象字段顺序不影响共享，数组顺序影响共享；不提供另一个业务 key 回调。
- 参数复制后深冻结，调用方原对象不冻结；轮询、恢复与 `readSnapshot` 复用已准备参数，`validate` 只在提交时执行一次。
- 只保留 JSON 值域与根容器守卫（数组／`null`／原始值／`Date` 根容器、`-0`、非有限数、非普通记录都拒绝），不做任意对象描述符、原型或跨 realm 的逐类防御；不设深度上限，循环引用由引擎递归耗尽调用栈报 `RangeError`。
- DTO 业务结构由 HTTP 适配器校验；框架只拒绝 `undefined` 并使用原生复制建立所有权，各页面与 `readSnapshot` 各得副本。
- `readSnapshot` 只算参数键并读副本，不复制冻结参数、不执行 `validate`、不创建实例；参数非法时抛给读取者。

## 安装与使用

```ts
const refresh = createRefreshManager({ maxConcurrent: applicationConfig.refreshConcurrency })
app.use(refresh)
if (import.meta.hot) import.meta.hot.dispose(() => refresh.dispose())
```

每个组件在同步 setup 中调用 `useRefresh`；`enabled` / `every` / `visible` 都支持值、Ref 或 getter，
整个 `options` 同样支持（`RefreshInput<RefreshOptions>`，传 Ref 时替换 `options.value` 即按新对象重新协调），
框架只读它们、从不写入。只监听这三项配置，不监听参数或表单。
`every` 只在 `enabled` 为真时必需：只手动刷新的页面可以整个省略它，开启而省略按配置非法拒绝。

`submit` 同步声明身份（同参重复声明幂等，参数被拒时不改动任何状态）；`refresh` 返回 success / error / cancelled，
取消立即结算且不携带 DTO。关闭 `enabled` 只退订、**不结算**已发起的刷新要求，因此暂停页仍能刷新一次。
显式刷新与自动刷新共用同一队列与并发槽，满槽时排队；后台只在真实 `load` 结束后释放并发槽，
另有一层框架上限（10 秒，从开始执行起算）到期即按共享请求失败结算并立即出册，因此挂死的请求不会让应用停摆。

刷新失败走两条通道：返回的 Promise 结算 `error`（`origin` 为 `request` 或 `configuration`），
同时 `onError` 收到同一次失败；两条通道分别给调用方控制流与统一错误出口，页面若两处都提示需自行去重。
错误通知还带产生它的声明代次（一个页面里两处 `useRefresh` 共用同一个 `onError` 时据此认领）。
**框架不改写调用方的 `enabled`**：失败后是否停止自动刷新由页面在 `onError` 里自己决定；
只要 `enabled` 仍为真，下个周期继续，暂停页也仍可主动刷新。

框架只有一条取数通道：显式刷新与自动刷新都经 Source 的 `load`，结果交付给**有效订阅与满足门槛的刷新要求**
（同一句柄只交付一次，来源按是否在等这次结果判定）。`display` 是唯一交付面：`args` / `data` / `origin` 与
`updatedAt`（结果产生的墙钟毫秒）同次整体发布，后加入的组件读到已有结果时拿到的仍是原结果时间，可据此显示数据多旧；
框架不交付「正在刷新」这类实时状态。需要按结果写业务 Store 的页面在自己的适配层完成。
只读共享结果用 `refresh.readSnapshot(source, params)`：它只交付值、不承诺新鲜度、不会创建实例或延长生存期。
`dispose` 幂等；应用卸载自动清理；SSR 不发请求。

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
`createRefreshManager`、`useRefresh`，三个状态常量对象（`RequestOrigin` / `ErrorOrigin` / `CancelReason`）以及 8 个公共类型（清单见统一文档 §2；工具型别名不导出，按推断使用）。`build:demo` 生成演示页面，HTTP fixture 只由开发服务提供。

默认示例在 http://127.0.0.1:4173/，验证页为 `/tests/browser.html`；端口被占用时用 `pnpm dev --port 4177`。
`pnpm test:browser` 在独立 4174 端口用 Playwright 执行与验证页相同的场景；默认使用系统 Chrome
（`channel: 'chrome'`），也可用 `PW_CHANNEL=bundled` 走随包 Chromium。

需要 Node 24（测试直接运行可擦除类型的 TypeScript）与 pnpm 11，无需额外 PATH 配置。

## 实际验证与边界

本次环境：Linux x86_64、Node 24.20.0、pnpm 11.24.0、Vue 3.5.42、TypeScript 7.0.2、Vite 8.3.0、Playwright 1.63.0（系统 Chrome）。
只验证当前安装组合，不声明其他版本支持。

| 实际检查 | 结果/范围 |
|---|---|
| pnpm typecheck | 通过，0 错误。`tests/types.ts` 的 `@ts-expect-error` 反例（缺字段/字段类型/旧元组调用/Source 不变性/DTO/readonly/refresh 不接受参数且结算不含 DTO）一并被校验 |
| pnpm test | 通过：35 个用例全绿（`tests/core.test.ts` 28、`tests/vue.test.ts` 7），覆盖 A01–A18。核心用例直接驱动 `RefreshCore` 并提供配置快照；Vue 用例用无 DOM 的自定义渲染器 ＋ 真实 KeepAlive，安装路径用最小 `document` 替身，不冒充真实可见性测试 |
| pnpm build | 通过。生成 `dist/index.js`（13.63 kB，13630 字节）与 5 个声明文件（构建后处理改写说明符为 `.js` 并断言产物形态） |
| pnpm build:demo | 通过。生成 `dist-demo/` 演示页面（四个视图：查询列表、行情面板、双组件共享、B09 组合） |
| pnpm test:browser | 通过：真实 Chrome 12 条场景全绿——三条代表页面交互（`tests/pages.spec.ts`）＋ 八条受控场景（`tests/refresh.spec.ts`：暂停后显式刷新、满槽排队、真实 HTTP 共享与恢复、真实传输超时、旧响应晚到、真实结束放槽、卸载清理、祖先 KeepAlive 失活与受控 `visibilitychange`）。这些场景在根契约重写后**未改一行**仍然通过 |
| pnpm complexity | 5 个源文件、1048 行、117 个结构分支、最大函数圈复杂度 11 |
| node scripts/benchmark.mjs | 24 订阅 / 8 身份 / every=25ms / maxConcurrent=4，3 次 × 2s：load 中位 635 次（收敛比 0.99；按订阅计的反事实 1920 次）、在途峰值 4（框架 `running` 投影峰值同为 4，未超上限）、结束瞬间 8 个共享实例 / 24 个句柄、**释放后残留全 0**；事件循环延迟 mean 1.08ms / p99 1.47ms / max 5.11ms。规模可用 `--subscriptions/--identities/--duration/--every/--runs` 改；**不设性能阈值**，只在真实在途超过 `maxConcurrent` 或释放后有残留时以非零码退出 |
| 阶段 15 交付产物 | `pnpm build` ＋ `pnpm pack` 生成 `vue-refresh-0.0.0.tgz`：9 个条目 = `dist/` 7 个（`index.js` 13.63 kB，13630 字节、sourcemap、5 个 `.d.ts`）＋ `package.json` ＋ README。最终包 SHA-256 记在[统一文档](./统一刷新管理.md) §5 的 G04 行，不写在这里——README 由 npm 强制打进包内，把包自身哈希写进包内文件没有解 |
| 包级导入（干净消费方） | 仓库外消费工程只安装 tarball 与 `vue@3.5.42`（不再需要状态库）：SSR 渲染成功且 0 次 `load`、`dispose` 后 `readSnapshot` 返回 `undefined`；最小浏览器环境（`document.hidden=false`）下挂载 ＋ `submit` 交付 `price=3`、`origin=background`、`readSnapshot` 可读。**换包必删消费方的 `package-lock.json`**：`file:` 依赖的完整性写在锁文件里，不删会复用上一版解包内容而给出假通过 |
| TS 4.9 类型消费（G03 阻断节点） | 实测：`typescript@4.9.5` ＋ `module/moduleResolution: Node16` ＋ `strict` ＋ `skipLibCheck` 下 `tsc --noEmit` **本包 5 个声明文件零错误**（含 `@ts-expect-error` 反例：缺字段、Source 不变性、`refresh` 不接受参数）；不再需要状态库，因此没有需要跳过的 peer 校验。Vue 3.5.42 自身的 `.d.ts` 要求 TS ≥5.4，故 `skipLibCheck: true` 是前置条件。确认人 2026-09-16 裁决：声明只限定到本包自身的类型（自 TS 4.9 起可用，已实测） |
| pnpm check:docs | 通过。一致性门禁清单与各项动机以 `scripts/check-docs.mjs` 的自述注释为准；还会打印叶子→测试标题的追溯报告 |

测试名称以验收叶子编号开头（`A01`–`A18`），只证明具体断言覆盖的分支，不把同一叶子的全部变体自动标通过。
核心测试覆盖声明幂等与校验失败不改状态、共享身份、恢复与不补跑、并发上限与 FIFO、框架上限出册与迟到结束无效、
失败结算与下个周期继续、交付副本独立、只读定位与参数守卫、回调隔离、销毁；
Vue 测试覆盖声明即取数、暂停与恢复、整段 `options` 换对象、KeepAlive 双向幂等、`visible` 条件、安装冲突与接管。
`pnpm check:docs` 的 `[trace]` 行给出机器读数：18 个叶子全部由测试标题点名，`部分验证` 0、`未验证` 0。

尚未取得的证据：**真实切标签页**（浏览器真正把本页置为 hidden）与**监听已摘除本身**（需要 CDP 的
`DOMDebugger.getEventListeners`，当前驱动拿不到；只能在真实浏览器里以「卸载后再派发 `visibilitychange`
不产生任何请求」作为可观察边界）、真实业务接入，以及**真实设备与真实流量下的性能口径**——
基线只测框架侧代理量，`load` 只让出一个微任务，不含浏览器渲染与真实网络。

正式文档为 `./统一刷新管理.md`（业务规则、契约、验收与门槛）、`./DESIGN.md`（设计与实现）与 `./ADR.md`（已裁决的产品边界与提案裁决）。
