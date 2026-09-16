// Documentation/code consistency gate. Read-only: it never rewrites a file.
// Checks what actually drifted before: the module manifest, the dependency direction,
// the public-contract mirror in the unified document, the README metrics row, the
// unified document's own section numbering, and the §0 vocabulary table's forms.
// The unified document lives in this repository root, so the check is self-contained.
// Usage: pnpm check:docs
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
const problems = []
const check = (ok, where, detail) => { if (!ok) problems.push(`${where}: ${detail}`) }
const read = path => readFileSync(root + path, 'utf8')
const modules = readdirSync(`${root}/src`).filter(name => name.endsWith('.ts')).sort()

// Drop comment-only content, so JSDoc may grow freely on both sides of the mirror.
function stripComments(text) {
  const kept = []
  let inBlock = false
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (inBlock) { if (trimmed.includes('*/')) inBlock = false; continue }
    if (trimmed.startsWith('/*')) { if (!trimmed.includes('*/')) inBlock = true; continue }
    if (trimmed.startsWith('//')) continue
    if (trimmed) kept.push(line.trimEnd())
  }
  return kept
}

// 1) Every ```text manifest block must list exactly the current source files.
for (const file of ['/README.md', '/DESIGN.md']) {
  const text = read(file)
  const block = /```text\n([\s\S]*?)```/.exec(text)
  check(Boolean(block), file, 'missing the ```text module manifest')
  if (block) {
    const listed = block[1].trimEnd().split('\n')
      .map(line => line.trim().split(/\s+/)[0].replace(/^src\//, '')).sort()
    check(listed.join(' ') === modules.join(' '), file,
      `module manifest differs\n    documented: ${listed.join(' ')}\n    sources:    ${modules.join(' ')}`)
  }

  // 2) The dependency-direction line may only name existing modules.
  const line = text.split('\n').find(value => value.includes('依赖方向单向'))
  check(Boolean(line), file, 'missing the dependency-direction line')
  if (line) {
    const named = [...line.matchAll(/`([^`]+)`/g)].flatMap(match => match[1].split('/'))
    for (const name of named) check(modules.includes(`${name}.ts`), file, `dependency direction names unknown module ${name}`)
  }
}

// 3) The unified document mirrors the public contract verbatim, comments excluded.
const design = read('/统一刷新管理.md')
const mirror = /### 2\.2 完整类型与状态取值[\s\S]*?```ts\n([\s\S]*?)```/.exec(design)
check(Boolean(mirror), '统一刷新管理.md §2.2', 'missing the TypeScript mirror block')
if (mirror) {
  const declared = stripComments(read('/src/public-types.ts'))
  const mirrored = stripComments(mirror[1])
  let index = 0
  while (index < declared.length && declared[index] === mirrored[index]) index++
  check(declared.length === mirrored.length && index === declared.length, '统一刷新管理.md §2.2',
    `mirror differs at line ${index + 1}\n    documented: ${mirrored[index] ?? '<end>'}\n    source:     ${declared[index] ?? '<end>'}`)
}

// 4) The README metrics row must match a live measurement.
const measured = JSON.parse(execFileSync(process.execPath, [`${root}/scripts/complexity.mjs`], { cwd: root, encoding: 'utf8' })).files
const totals = [measured.length, measured.reduce((sum, file) => sum + file.lines, 0),
  measured.reduce((sum, file) => sum + file.branches, 0), Math.max(...measured.map(file => file.maxCCN))]
const row = read('/README.md').split('\n').find(value => value.includes('pnpm complexity |'))
check(Boolean(row), '/README.md', 'missing the pnpm complexity row')
if (row) {
  const documented = (row.match(/\d+/g) ?? []).map(Number)
  check(documented.join(' ') === totals.join(' '), '/README.md',
    `metrics row differs\n    documented: ${documented.join(' ')}\n    measured:   ${totals.join(' ')}`)
}

// 5) Section numbering inside the unified document must be self-consistent: unique, and
//    every child must follow its parent. Merge residue such as a "8.1.1" label sitting under
//    §4.1 (while §8.1 means something else) is caught here.
const numbered = []
for (const line of design.split('\n')) {
  const heading = /^#{1,6}\s+(\d+(?:\.\d+)*)[\s.、]/.exec(line)
  const bold = /^\*\*(\d+(?:\.\d+)*)\s/.exec(line)
  const id = heading?.[1] ?? bold?.[1]
  if (id) numbered.push(id)
}
const seen = new Set()
for (const id of numbered) {
  check(!seen.has(id), '统一刷新管理.md', `duplicate section number ${id}`)
  seen.add(id)
  const parent = id.includes('.') ? id.slice(0, id.lastIndexOf('.')) : null
  if (parent) check(seen.has(parent), '统一刷新管理.md', `section ${id} appears before its parent ${parent}`)
}

// 6) Rule ↔ acceptance traceability must stay complete in both directions: every acceptance
//    leaf is cited by at least one capability domain, and no domain cites a leaf that no longer
//    exists. Each §3 capability block ends in one 判定 line; ranges such as "L03–L08" are expanded
//    before comparing. Rule ids are never hardcoded here — §3 is free to merge or renumber its
//    capability blocks without touching this script. The leaf regex tolerates the optional
//    `[行为]` / `[不变量]` / `[混合]` ownership prefix so that #8 can report a leaf that lost it.
const rulesStart = design.indexOf('## 3. 行为规则')
const rulesEnd = design.indexOf('## 4. 验收目录')
// §4 ends at §5; the variant index that used to bound it is gone (variants are inline now).
const catalogueEnd = design.indexOf('## 5. ')
const catalogue = design.slice(rulesEnd, catalogueEnd)
const rulesText = design.slice(rulesStart, rulesEnd)
const LEAF = /^\| (?:\[[^\]]+\] )?([A-Z]\d{2}[a-z]?)\*? \|/
const leaves = new Set()
for (const line of catalogue.split('\n')) {
  const id = LEAF.exec(line)?.[1]
  if (id) leaves.add(id)
}
const cited = new Set()
for (const line of rulesText.split('\n')) {
  const body = /^判定：(.*)$/.exec(line)?.[1]
  if (!body) continue
  for (const piece of body.split(/[、,，/]/)) {
    const range = /^([A-Z])(\d{2})[a-z]?[–-]([A-Z])(\d{2})[a-z]?$/.exec(piece.trim())
    if (range && range[1] === range[3]) {
      for (let n = Number(range[2]); n <= Number(range[4]); n++) cited.add(`${range[1]}${String(n).padStart(2, '0')}`)
    } else if (/^[A-Z]\d{2}[a-z]?$/.test(piece.trim())) cited.add(piece.trim())
  }
}
check(cited.size > 0, '统一刷新管理.md §3', 'no acceptance citations parsed from the capability blocks')
const orphan = [...leaves].filter(id => !cited.has(id)).sort()
const dangling = [...cited].filter(id => !leaves.has(id)).sort()
check(orphan.length === 0, '统一刷新管理.md §4', `leaves cited by no capability domain: ${orphan.join(' ') || '-'}`)
check(dangling.length === 0, '统一刷新管理.md §3', `capability domains cite missing leaves: ${dangling.join(' ') || '-'}`)

// 7) Every trigger anchor is declared exactly once, and no document references an anchor that does
//    not exist. This replaces counting a fixed rule list: §3 may merge 25 trigger rules into 8
//    capability blocks (or split them again), and the check still holds because the anchor set is
//    read from §3 rather than assumed. An undeclared `U…` reference is how a merge silently breaks
//    cross-document links, which §0 / §5.1 / DESIGN use in 20+ places.
const declared = new Map()
for (const line of rulesText.split('\n')) {
  const id = /^- `(U\d{1,3})` /.exec(line)?.[1]
  if (id) declared.set(id, (declared.get(id) ?? 0) + 1)
}
check(declared.size > 0, '统一刷新管理.md §3', 'no trigger anchors declared')
const doubled = [...declared].filter(([, count]) => count > 1).map(([id]) => id)
check(doubled.length === 0, '统一刷新管理.md §3', `trigger anchors declared more than once: ${doubled.join(' ') || '-'}`)
for (const file of ['/统一刷新管理.md', '/DESIGN.md', '/README.md', '/ADR.md']) {
  const danglingAnchors = [...new Set([...read(file).matchAll(/\bU\d{1,3}\b/g)].map(match => match[0]))]
    .filter(id => !declared.has(id)).sort()
  check(danglingAnchors.length === 0, file,
    `references trigger anchors that §3 does not declare: ${danglingAnchors.join(' ') || '-'}`)
}

// 8) Every acceptance leaf carries exactly one ownership prefix, and the prefix vocabulary is
//    closed. The three groups used to be section-level claims in §4.1 plus an exception paragraph;
//    an inline prefix says the same thing where the leaf is, so adding or removing a leaf touches one
//    place and a hole (a leaf nobody assigned) or an overlap stays impossible. A leaf row without a
//    prefix is reported by name rather than silently dropped from the #6 count.
const OWNERSHIP = ['行为', '不变量', '混合']
const ownership = new Map()
const unlabelled = []
for (const line of catalogue.split('\n')) {
  const id = LEAF.exec(line)?.[1]
  if (!id) continue
  const prefix = /^\| \[([^\]]+)\] /.exec(line)?.[1]
  if (!prefix) { unlabelled.push(id); continue }
  ownership.set(prefix, (ownership.get(prefix) ?? 0) + 1)
}
check(unlabelled.length === 0, '统一刷新管理.md §4',
  `leaves without an ownership prefix: ${unlabelled.join(' ') || '-'}`)
const unknownOwnership = [...ownership.keys()].filter(prefix => !OWNERSHIP.includes(prefix)).sort()
check(unknownOwnership.length === 0, '统一刷新管理.md §4',
  `ownership prefixes outside ${OWNERSHIP.join(' / ')}: ${unknownOwnership.join(' ') || '-'}`)
for (const prefix of OWNERSHIP) {
  check(ownership.has(prefix), '统一刷新管理.md §4', `no leaf carries the [${prefix}] prefix`)
}

// 9) The dependency graph must match the documented direction: a runtime edge may only point at a
//    lower layer. Same-layer and upward runtime edges are exactly how ARCH-09 / ARCH-04b drifted in
//    unnoticed, so they now fail unless the pair is acknowledged here *and* explained in DESIGN.md.
//    Type-only edges are erased at runtime: an upward one is reported, and same-layer ones between
//    the members of one layer are counted, so the distinction stays visible instead of silent.
//    Layer numbers follow the README 「依赖方向单向」 line.
const LAYERS = {
  'diagnostics.ts': 0, 'public-types.ts': 0, 'model.ts': 1, 'source.ts': 1, 'delivery.ts': 1,
  'store.ts': 2, 'scheduler.ts': 2, 'manager.ts': 3, 'app.ts': 4, 'vue.ts': 4, 'index.ts': 5,
}
const ACKNOWLEDGED_EDGES = ['vue.ts → app.ts']
// Three forms are edges: a static `from './x'` clause, a bare side-effect import (`import './x'`),
// and a dynamic `import('./x')`. Matching only the static form left the graph partly invisible: a
// same-layer or upward runtime edge written as a bare or dynamic import passed this gate, so the
// acknowledged-edge list could look clean while the direction was broken. Dynamic imports are
// runtime edges whatever the importer later does with the value.
const edges = []
const addEdge = (from, spec, typeOnly) => {
  if (!spec.startsWith('./')) return
  const to = spec.replace(/^\.\//, '')
  if (!edges.some(edge => edge.from === from && edge.to === to && edge.typeOnly === typeOnly)) {
    edges.push({ from, to, typeOnly })
  }
}
for (const file of modules) {
  for (const statement of read(`/src/${file}`).split(/\n(?=(?:import|export)\s)/)) {
    const named = /\bfrom\s*['"](\.\/[^'"]+)['"]/.exec(statement)
    if (named) addEdge(file, named[1], /^(?:import|export)\s+type\s/.test(statement))
    for (const bare of statement.matchAll(/\bimport\s*['"](\.\/[^'"]+)['"]/g)) {
      addEdge(file, bare[1], false)
    }
    for (const dynamic of statement.matchAll(/\bimport\s*\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)) {
      addEdge(file, dynamic[1], false)
    }
  }
}
const designText = read('/DESIGN.md')
let peerTypeEdges = 0
let backTypeEdges = 0
for (const edge of edges) {
  check(LAYERS[edge.to] !== undefined, 'src', `${edge.from} imports unknown module ${edge.to}`)
  if (LAYERS[edge.to] === undefined || LAYERS[edge.to] < LAYERS[edge.from]) continue
  if (edge.typeOnly) {
    if (LAYERS[edge.to] > LAYERS[edge.from]) {
      backTypeEdges++
      console.log(`[docs] type-only back edge (erased at runtime): ${edge.from} → ${edge.to}`)
    } else {
      peerTypeEdges++
    }
    continue
  }
  const label = `${edge.from} → ${edge.to}`
  check(ACKNOWLEDGED_EDGES.includes(label), 'src',
    `runtime edge ${label} is not downward and is not acknowledged in scripts/check-docs.mjs`)
  check(designText.includes(label), 'DESIGN.md', `acknowledged runtime edge ${label} is not explained in DESIGN.md §1`)
}

// 10) The published entry must stay declarable on the TS 4.9 baseline: `export type *` is TS 5.0+
//     syntax. The declaration-file half of this rule lives in scripts/fix-dts.mjs, which only ever
//     sees a freshly built `dist/`; asserting it here on a possibly stale `dist/` would be a fake
//     signal in both directions.
const entry = read('/src/index.ts')
check(!/^export\s+type\s+\*/m.test(entry), '/src/index.ts', 'must list exported types explicitly (export type * requires TS 5.0+)')

// 11) `manager.ts` has no class body worth reading top to bottom without its `═══` banners, and the
//     documented section list is the only map of them. The list drifted once (six documented, seven
//     in the code), so both documents must name the same sections in the same order.
const banners = [...read('/src/manager.ts').matchAll(/═+ ([^═\n]+?) ═+/g)].map(match => match[1].trim())
check(banners.length > 0, '/src/manager.ts', 'no section banners found')
for (const file of ['/README.md', '/DESIGN.md']) {
  const listed = /按职责分成[一二三四五六七八九十]+个分段：([^。\n]+)/.exec(read(file))
  check(Boolean(listed), file, 'missing the manager section list')
  if (listed) {
    // The list may sit mid-sentence, so a trailing separator is not part of the last section name.
    const names = listed[1].replace(/[；;。]\s*$/, '').split('、').map(name => name.trim())
    check(names.join('|') === banners.join('|'), file,
      `manager sections differ\n    documented: ${names.join('、')}\n    code:       ${banners.join('、')}`)
  }
}

// 12) A topic-style citation ("配置无效通知与诊断内容的行为规则见 §3（U18、U19）") promises that the
//     named anchors still carry those topics. #7 cannot see the promise — it only checks that the anchor
//     exists. C-02 removed the sequence-exhaustion rule from U14, §2.4 kept citing U14 for it, and every
//     check stayed green: additions were gated, deletions were not. Each citation is therefore spelled out
//     below as topic ↔ anchor ↔ the phrase that must still be in that anchor's rule, so deleting a
//     behaviour fails here instead of going silent. §6.2 requires updating this table with the citation.
//     The anchor list must be literal `U…` ids, so a sentence *about* citations (`§3（U…）`) is not one.
const TOPIC_CITATIONS = [
  { claim: '配置无效通知', anchor: 'U18', phrase: '配置快照无效' },
  { claim: '诊断内容', anchor: 'U19', phrase: 'observer' },
]
for (const line of design.split('\n')) {
  const citation = /^(.+?)的行为规则见 §3（(U\d{1,3}(?:、U\d{1,3})*)）/.exec(line)
  if (!citation) continue
  const topics = citation[1].split(/[、与]/).map(value => value.trim()).filter(Boolean)
  const anchors = citation[2].split('、').map(value => value.trim()).filter(Boolean)
  check(topics.length === anchors.length, '统一刷新管理.md', `topic citation pairs ${topics.length} topics with `
    + `${anchors.length} anchors: ${topics.join('、')} → ${anchors.join('、')}`)
  topics.forEach((topic, index) => {
    const anchor = anchors[index]
    const bullet = rulesText.split('\n').find(value => value.startsWith(`- \`${anchor}\` `))
    check(Boolean(bullet), '统一刷新管理.md §3', `topic citation "${topic}" points at undeclared anchor ${anchor}`)
    const entry = TOPIC_CITATIONS.find(value => value.claim === topic && value.anchor === anchor)
    check(Boolean(entry), 'scripts/check-docs.mjs',
      `topic citation "${topic}" → ${anchor} is not declared in TOPIC_CITATIONS`)
    if (entry) {
      check(Boolean(bullet?.includes(entry.phrase)), '统一刷新管理.md §3',
        `topic citation "${topic}" points at ${anchor}, whose rule no longer mentions "${entry.phrase}"`)
    }
  })
}

// 13) §0 is the document's lookup table, so it must behave like one. (a) Every row must offer at
//     least one form the rest of the document actually uses: 11 rows once registered `订阅声明/声明`,
//     `数据身份`, `P / T`, `Parameters`, `Task / load`, `StoreEntry`, … while the rules said 声明,
//     身份, 参数快照, 任务, 分区 instead — a table you cannot look anything up in. (b) No form may be
//     registered twice: `刷新要求` sat in both §0.1 and §0.2 with the same opening sentence, and the
//     §0.2 copy leaked the internal version floor. (c) §0 states outward meaning only, so no
//     internal-only field name may appear in it. Forms come from the first column of the tables whose
//     header is `名称`; §0.1's disambiguation table has its own header and is not a row source, but it
//     is §0 text and still counts for (c). The §2.2 code block is skipped in (a): every public type
//     name appears there by definition, so counting it would make the check vacuous.
const vocabulary = design.slice(design.indexOf('## 0. 名词解释'), design.indexOf('## 1. 目标与范围'))
const vocabularyRows = []
let tableHeader = null
for (const line of vocabulary.split('\n')) {
  if (!line.startsWith('|')) { tableHeader = null; continue }
  if (tableHeader === null) { tableHeader = line; continue }
  if (/^\|[-: |]+\|$/.test(line)) continue
  if (/^\| 名称 \|/.test(tableHeader)) vocabularyRows.push(line.split('|')[1].trim())
}
const formsOf = cell => cell.replace(/`/g, '').split(' / ')
  .map(part => part.replace(/（[^）]*）?\s*$/, '').trim()).filter(Boolean)
const documentBody = design.slice(design.indexOf('## 1. 目标与范围'))
  .replace(/### 2\.2[\s\S]*?```[\s\S]*?```/, '')
for (const cell of vocabularyRows) {
  const forms = formsOf(cell)
  check(forms.some(form => documentBody.includes(form)), '统一刷新管理.md §0',
    `vocabulary row "${cell}" is dead: no form of it appears outside §0; register the form the rules use`)
}
const allForms = vocabularyRows.flatMap(formsOf)
for (const form of new Set(allForms)) {
  const count = allForms.filter(value => value === form).length
  check(count === 1, '统一刷新管理.md §0', `vocabulary form "${form}" is registered ${count} times`)
}
// Field names owned by DESIGN §3.3. Add one here when that table gains a persistent field; leaving it
// out would only weaken (c), never fail it.
const INTERNAL_FIELDS = ['operationId', 'minVersion', 'issuedVersion', 'issuedResourceId',
  'lastSettledAt', 'lifecycleActive', 'waiters', 'subscribers', 'refreshes', 'flushPending',
  'cancelTimer', 'browserVisible', 'controller', 'settle', 'cleanup', 'reported']
for (const field of INTERNAL_FIELDS) {
  check(!vocabulary.includes(field), '统一刷新管理.md §0',
    `§0 states outward meaning only, but names the internal field ${field} (DESIGN §3.3)`)
}

if (problems.length) {
  for (const problem of problems) console.error('[docs]', problem)
  process.exit(1)
}
// The leaf → test-title traceability report is printed, never enforced: a leaf absent from every
// test title is a review aid, not a defect, so it must not fail this gate.
console.log(execFileSync(process.execPath, [`${root}/scripts/trace-leaves.mjs`], { cwd: root, encoding: 'utf8' }).trimEnd())
console.log(`[docs] consistent: ${modules.length} modules, contract mirror, README metrics, `
  + `${declared.size} trigger anchors, capability blocks, `
  + `dependency direction, published entry, manager sections, ${TOPIC_CITATIONS.length} topic citations, `
  + `${vocabularyRows.length} vocabulary rows, ${leaves.size} layered leaves, `
  + `${peerTypeEdges} peer type edges, ${backTypeEdges} type-only back edges`)
