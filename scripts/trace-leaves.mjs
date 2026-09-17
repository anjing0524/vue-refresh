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
  // 暂无：A01–A18 全部由测试标题直接点名（根契约重写后叶子从 129 降到 18，标题即账目）。
}
const STATIC = {
  // 暂无。
}
const PARTIAL = {
  // 暂无。
}
const UNVERIFIED = {
  // 暂无。
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
