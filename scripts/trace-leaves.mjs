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
  'A01/A02/A06/B06/P08/Q08: 入口返回契约在正确边界保留或清空需求': ['B13a', 'C04', 'P09'],
  'Q07/D01/D02/D04/F09/L10: 刷新要求随隐藏、暂停边沿与卸载作废；恢复不重放刷新': ['R11'],
  'P03/L01/L02/L03/L09/P07/R05/A03: share, history, copies, updatedAt, cancel and resource rebirth': ['B12b', 'B13b', 'F01', 'M07', 'R07', 'S04', 'T08', 'T13'],
  'Q01/Q04/B05/Q13: 暂停页刷新走共享路径，交付本页与有效订阅，不惊动其他暂停页': ['Q02'],
  'Q03/A02/D03/B02/F02: 刷新失败结算本次等待、保留旧画面，订阅下周期继续': ['M06'],
  'F06/F07/A01.04: 校验重入与替换身份时的 abort 重入都由新声明接管': ['F03'],
  'F11/T10/T11/T12/M04: FIFO 顺序、真实结束释放槽位、退订作废排队任务': ['R06'],
  'F14/R01/R02: 后台失败对每个有效订阅各通知一次；onError 里改频率不打断本次通知': ['M06', 'R03'],
  'U11/T04/T01/T02/T06/T07/C09: 改频率只重算到期，保留在途请求；最短间隔与分段等待': ['T09'],
  'M01–M09/F11/F12: seed 42, 300 有限步保持归属、并发槽与刷新要求': ['P04', 'S01'],
  'C01/C02/P02: full-value object keys, sorted nested fields, arrays and scalar distinctions': ['P09'],
  'C11: native clone preserves supported values and independent ownership': ['R09'],
  'A07/B08/F09: 配置非法拒绝新刷新并按资格退出订阅；修正后恢复': ['C10'],
  'F05/A05: onError reentry cannot be overwritten by old failure': ['M08'],
  'S05: two real SSR renders create no request, timer or shared state': ['C08'],
  'P01/C03/C13: resource validation runs once per submission, never on restore or lookup': ['C12', 'S03'],
  '查询列表：提交才发请求、分页排序复用已提交参数、独立启停、暂停仍可单查、失败关闭': ['Q10'],
  '双组件共享：1s/5s 同参共享、单页暂停、重新进入交付已有结果、切换品种、全部退订、快照隔离': ['P04', 'S03', 'S04'],
  'B09：无启停按钮，前次失败后在 runner 内开启意愿，不先请求旧参数': ['Q11'],
  '真实HTTP：共享、单页冻结、最后取消、恢复': ['R10'],
}
const STATIC = {
  S09: 'pnpm typecheck：tests/types.ts 的 @ts-expect-error 反例（缺字段、字段类型、旧元组调用、Source 不变性、DTO、readonly、refresh 不接受参数且结算不含 DTO）',
}
const PARTIAL = {
  B03: '失败后画面保留由「查询列表」覆盖；「保留 A 画面时提交 B，展示参数仍标注 A」无断言（核心测试从未断言 display.args）',
  B07: '校验失败清参数由 A01/A02/A06/B06/P08 覆盖；「失败后改频率」「失败后隐藏再恢复」两个变体无定向断言',
  B11: '回调替换后剩余旧通知停止由 F14/R01/R02 覆盖；「退订又新增订阅」的遍历形态无定向断言',
  B14: '旧版本不影响重建后的 Resource 由 P03/… 覆盖；「刷新要求绑定对象身份」无定向断言',
  B15: '参数值决定身份由 C01/C02/P02 覆盖；「同一 URL 的不同租户/权限条件不错误共享」无定向断言（属 U02 的边界规则）',
  F13: '最小 every 由 T01/T02/T04/T06/T07/C09 与 M01–M09 覆盖；「每次扫描只聚合一次、计数随订阅线性增长」无算法计数断言',
  P06: '单页暂停断言了「一方退订不取消另一方的资源」；「甲进入 B 而乙留在 A」的变体未断言',
  S08: '真实传输取消由场景「真实HTTP：共享、单页冻结、最后取消、恢复」覆盖；超时变体无定向断言',
  M10: '变体 01（独立克隆安装与构建）已完成（commit 320e982 的克隆复现）；变体 02（包级导入与包内清单核对）属阶段 15',
  T05: '「刷新期间改频率」由 M02/U05 覆盖、「关闭时改频率」由 B04/F08 覆盖；「失活时改频率」无断言',
  T14: '合法 1 / Number.MAX_SAFE_INTEGER 与 NaN、0 有断言；−1、小数、±Infinity、−0、非 number 与 Ref/getter 全项未逐一断言',
}
const UNVERIFIED = {
  // 暂无：§7 13.1 曾列出的 9 项（B04 B16a C05 C06 F08 L06 L08 P05 S06）已由
  // 「B04/F08」「B16a」「C05」「C06」「L06」「L08」「P05」「S06」八条定向用例点名。
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
