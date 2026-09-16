// Acceptance-leaf → test-title traceability report. Read-only and deliberately non-blocking:
// it prints facts, it never gates. A leaf that no test title names is not proof it is untested —
// it may be asserted inside a test titled after another leaf — so this is a review aid, and
// `check:docs` only prints its summary instead of failing on it.
//
// `--map` additionally prints, per capability domain, the `U…` trigger anchors it carries and the
// acceptance leaves that judge them, each marked when a test title names it. §3 keeps one 判定 line
// per capability domain (that is what the A1-01 merge bought), so the anchor → leaf hop is only
// resolvable to the domain; this flag makes that resolution a machine product instead of a reading
// exercise, without re-fragmenting §3.
// Usage: node scripts/trace-leaves.mjs [--map]
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const doc = readFileSync(`${root}/统一刷新管理.md`, 'utf8')
const lines = doc.split('\n')

// Leaves are the §4 rows, which carry an ownership prefix (`| [行为] T11 | … |`). Branch variants no
// longer have rows of their own: they live in the leaf's own row as `变体：01 …`, so they inherit that
// leaf's traceability instead of being counted separately. `lines` is an array, so the boundaries are
// found by prefix, not by substring.
const catalogStart = lines.findIndex(line => line.startsWith('## 4. '))
const catalogEnd = lines.findIndex(line => line.startsWith('## 5. '))
const leaves = new Set()
for (const line of lines.slice(catalogStart, catalogEnd)) {
  const id = /^\| (?:\[[^\]]+\] )?([A-Z]\d{2}[a-z]?)\*? \|/.exec(line)?.[1]
  if (id) leaves.add(id)
}

let source = ''
for (const name of readdirSync(`${root}/tests`).sort()) {
  if (name.endsWith('.ts')) source += '\n' + readFileSync(`${root}/tests/${name}`, 'utf8')
}
const titles = [...source.matchAll(/test\(\s*['"]([^'"]+)['"]/g)].map(match => match[1])
// A scenario name is a test title at runtime (`test(scenario.name)`), so the six browser scenarios
// judge leaves too and are addressable evidence below.
titles.push(...[...readFileSync(`${root}/tests/scenarios.ts`, 'utf8')
  .matchAll(/\{\s*name:\s*'([^']+)'/g)].map(match => match[1]))
const claimed = new Set()
for (const title of titles) {
  for (const match of title.matchAll(/\b[A-Z]\d{2}[a-z]?\b/g)) claimed.add(match[0])
}

/**
 * 逐 ID 证据账（§7 13.1）。测试标题只点名它真正判定的那几条叶子，其余叶子在这里逐条落定，
 * 状态词只用 §6.2 的三个：`已验证`（点名或 `EVIDENCE`）/ `部分验证`（`PARTIAL`）/ `未验证`。
 * 四项都不登记的叶子会被报成账目缺项，登记了却已被标题点名的叶子会被报成重复登记。
 *
 * - `EVIDENCE`：某个测试的断言覆盖了这条叶子，但该测试标题没有点名它。键是脚本实际看到的标题
 *   原文（`badData` 那种拼接标题以脚本看到的前缀为键，见末尾一条注释），值是被它判定的叶子。
 * - `STATIC`：证据不在测试里，而是类型检查、包级导入这类静态检查。
 * - `PARTIAL`：只覆盖部分变体，写明缺哪一条。
 * - `UNVERIFIED`：没有断言，写明原因。
 */
const EVIDENCE = {
  'A01/A02/A06/B06/P08: entry return contracts preserve or clear demand at the correct boundary': ['B01', 'B13a', 'C04', 'M05', 'P09'],
  'D01/D02/D03/D04/F09: inactive query preserves validated demand, not runner; invalid every does not cancel': ['M05'],
  'P03/L01/L02/L03/L09/P07/R05/A03: share, history, copies, updatedAt, cancel and resource rebirth': ['B12b', 'B13b', 'F01', 'L04', 'M03', 'M07', 'R07', 'S04', 'T08', 'T13'],
  'Q01/Q05/Q12/A04: paused query, superseding, immediate cancellation and stale commit': ['R11', 'S02'],
  'M02/U05: a query in flight is never replaced by a background subscription': ['Q02'],
  'A02/Q03/Q08/F05: execution failure settles and notifies before onError reentry; new query survives': ['M06'],
  'F06/F07: abort reentry during preparation owns the new operation before validation': ['F03', 'Q07'],
  'F11/T10/T11/T12/M04: FIFO replacement moves to tail, abort does not free physical slot': ['R06'],
  'F14/R01/R02: first failure callback replaces task; remaining old notifications stop': ['M06', 'R03'],
  'T01/T02/T04/T06/T07/C09: min interval, full wait after settlement, segmented timer': ['T09'],
  'M01–M09/F11/F12: seed 42, 300 finite operations preserve ownership and physical slots': ['P04', 'S01'],
  'C01/C02/P02: full-value object keys, sorted nested fields, arrays and scalar distinctions': ['P09'],
  'C11: native clone preserves supported values and independent ownership': ['R09'],
  'L05/L07/L10/M01: actual KeepAlive deactivation, duplicate mount/activation, restoration and unmount': ['L04'],
  'A07/B08/F09: invalid configuration rejects new query, preserves current query and recovers': ['C10'],
  'F05/A05: onError reentry cannot be overwritten by old failure': ['M08'],
  'S05: two real SSR renders create no request, timer or shared state': ['C08'],
  'P01/C03/C13: resource validation runs once per submission, never on restore or lookup': ['C12', 'S03'],
  '查询列表：提交才发请求、分页排序复用已提交参数、独立启停、暂停仍可单查、失败关闭': ['Q10'],
  '双组件共享：1s/5s 同参共享、单页暂停、重新进入交付已有结果、切换品种、全部退订、快照隔离': ['P04', 'S03', 'S04'],
  'B09：无启停按钮，前次失败后在 runner 内开启意愿，不先请求旧参数': ['Q11'],
  '独立查询不等后台槽：关闭立即取消，其他订阅继续': ['Q13'],
  '真实HTTP：共享、单页冻结、最后取消、恢复': ['R10'],
}
const STATIC = {
  S09: 'pnpm typecheck：tests/types.ts 的 @ts-expect-error 反例（缺字段、字段类型、旧元组调用、Source 不变性、DTO、readonly、async commit）',
}
const PARTIAL = {
  B03: '失败后画面保留由「查询列表」覆盖；「保留 A 画面时提交 B，展示参数仍标注 A」无断言（核心测试从未断言 display.args）',
  B07: '校验失败清参数由 A01/A02/A06/B06/P08 覆盖；「失败后改频率」「失败后隐藏再恢复」两个变体无定向断言',
  B11: '回调替换后剩余旧通知停止由 F14/R01/R02 覆盖；「退订又新增订阅」的遍历形态无定向断言',
  B14: '旧版本不影响重建后的 Resource 由 P03/… 覆盖；「查询门槛绑定对象身份」无定向断言',
  B15: '参数值决定身份由 C01/C02/P02 覆盖；「同一 URL 的不同租户/权限条件不错误共享」无定向断言（属 U02 的边界规则）',
  F13: '最小 every 由 T01/T02/T04/T06/T07/C09 与 M01–M09 覆盖；「每次扫描只聚合一次、计数随订阅线性增长」无算法计数断言',
  P06: '单页暂停断言了「一方退订不取消另一方的资源」；「甲进入 B 而乙留在 A」的变体未断言',
  Q06: 'supersede 语义由 Q01/Q05/Q12/A04 覆盖；「相同参数」这一分支未断言',
  S08: '真实传输取消由场景「真实HTTP：共享、单页冻结、最后取消、恢复」覆盖；超时变体无定向断言',
  M10: '变体 01（独立克隆安装与构建）已完成（commit 320e982 的克隆复现）；变体 02（包级导入与包内清单核对）属阶段 15',
  T03: '最小间隔由 T01/T02/T04/T06/T07/C09 覆盖；「新加入者间隔更短时先交付已有数据」无定向断言',
  T05: '「query 进行中改频率」由 M02/U05 覆盖；「关闭时改频率」「失活时改频率」两个变体无断言',
  T14: '合法 1 / Number.MAX_SAFE_INTEGER 与 NaN、0 有断言；−1、小数、±Infinity、−0、非 number 与 Ref/getter 全项未逐一断言',
}
const UNVERIFIED = {
  B04: '同一同步栈内多次改 every 后关闭：无定向断言',
  B16a: 'commit 回调内同步提交新查询：无定向断言',
  C05: '页面交付通知抛错时其余订阅继续、Store 不回滚：无定向断言',
  C06: 'useRefresh 在非同步 setup 调用被明确拒绝：无定向断言',
  F08: '同一同步栈内多次改 every 后关闭、中间排队任务不执行 load：无定向断言（与 B04 同缺口）',
  L06: '首查中失活/取消后「不报首查失败、恢复可重新首查」：无断言',
  L08: 'visible=false 与初始隐藏不发请求：三个变体均无断言（真实浏览器可见性组合另见 README）',
  P05: '同 URL、不同 Source 对象不自动合并：无定向断言',
  S06: '会话切换后旧请求晚到不写新会话：无定向断言',
}

const ledger = new Map()
const EVIDENCE_LEAVES = new Set(Object.values(EVIDENCE).flat())
for (const [title, ids] of Object.entries(EVIDENCE)) {
  if (!titles.includes(title)) ledger.set(title, 'is not a test title in tests/')
  for (const id of ids) if (!leaves.has(id)) ledger.set(id, 'is not an acceptance leaf in §4')
}
for (const map of [STATIC, PARTIAL, UNVERIFIED]) {
  for (const id of Object.keys(map)) if (!leaves.has(id)) ledger.set(id, 'is not an acceptance leaf in §4')
}
const status = new Map()
for (const id of leaves) {
  const sources = [claimed.has(id) && 'named', EVIDENCE_LEAVES.has(id) && 'EVIDENCE',
    id in STATIC && 'STATIC', id in PARTIAL && 'PARTIAL', id in UNVERIFIED && 'UNVERIFIED'].filter(Boolean)
  if (sources.length !== 1) ledger.set(id, `${sources.length} statuses: ${sources.join('/') || 'none'}`)
  status.set(id, sources[0])
}
const byStatus = name => [...status].filter(([, value]) => value === name).map(([id]) => id).sort()
const MARK = { named: '', EVIDENCE: '*', STATIC: '+', PARTIAL: '?', UNVERIFIED: '!' }

const uncovered = byStatus(undefined)
const named = [...claimed].filter(id => leaves.has(id)).length
// `U01`–`U25` are §3 trigger anchors, not acceptance ids, so they are expected in test titles.
const dangling = [...claimed].filter(id => !leaves.has(id) && !/^U\d{1,3}$/.test(id)).sort()

console.log(`[trace] ${leaves.size} leaves → 已验证 ${named} by test title + ${EVIDENCE_LEAVES.size} by EVIDENCE `
  + `+ ${Object.keys(STATIC).length} static, 部分验证 ${byStatus('PARTIAL').length}, 未验证 ${byStatus('UNVERIFIED').length}; `
  + `${titles.length} test titles`)
if (uncovered.length) console.log(`[trace] leaves with no status: ${uncovered.join(' ')}`)
if (dangling.length) {
  console.log(`[trace] named in a test title but not an acceptance leaf: ${dangling.join(' ')}`)
}
if (byStatus('PARTIAL').length) console.log(`[trace] 部分验证: ${byStatus('PARTIAL').join(' ')}`)
if (byStatus('UNVERIFIED').length) console.log(`[trace] 未验证: ${byStatus('UNVERIFIED').join(' ')}`)
if (ledger.size) console.log(`[trace] 证据账问题: ${[...ledger].map(([key, why]) => `${key} ${why}`).join('; ')}`)

if (process.argv.includes('--map')) {
  console.log(`[trace] legend: 无后缀=测试标题点名, *=EVIDENCE 登记, +=静态检查, ?=部分验证, !=未验证`)
  const rules = doc.slice(doc.indexOf('## 3. 行为规则'), doc.indexOf('## 4. 验收目录'))
  for (const block of rules.split(/^### /m).slice(1)) {
    const domain = /^[\d.]+ (R\d [^\n]*)/.exec(block)?.[1] ?? '(unnamed domain)'
    const anchors = [...block.matchAll(/^- `(U\d{1,3})`/gm)].map(match => match[1])
    const judged = new Set()
    for (const piece of (/^判定：(.*)$/m.exec(block)?.[1] ?? '').split(/[、,，/]/)) {
      const range = /^([A-Z])(\d{2})[a-z]?[–-]([A-Z])(\d{2})[a-z]?$/.exec(piece.trim())
      if (range && range[1] === range[3]) {
        for (let n = Number(range[2]); n <= Number(range[4]); n++) judged.add(`${range[1]}${String(n).padStart(2, '0')}`)
      } else if (/^[A-Z]\d{2}[a-z]?$/.test(piece.trim())) judged.add(piece.trim())
    }
    const sorted = [...judged].sort()
    const namedHere = sorted.filter(id => status.get(id) === 'named')
    console.log(`[trace] ${domain}: ${anchors.join(' ')} -> ${sorted.length} leaves, ${namedHere.length} test-named`)
    console.log(`[trace]   ${sorted.map(id => id + MARK[status.get(id)]).join(' ')}`)
  }
}
