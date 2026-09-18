// Documentation/code consistency gate. Read-only: it never rewrites a file.
// Checks what actually drifted before: the module manifest, the dependency direction,
// the public-contract mirror in the unified document, the README metrics row, the recorded
// built-artifact size, the export-surface counts and API list, the test totals, the code symbols
// both normative documents promise, the unified document's own section numbering, the §0 vocabulary
// table's forms, and the core section banners.
// The unified document lives in this repository root, so the check is self-contained.
// Usage: pnpm check:docs
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
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
// ADR.md is excluded: it is a historical decision record and quotes the anchors in force at the time
// (ADR-27 retires the previous anchor family wholesale, so those quotes must stay as written).
for (const file of ['/统一刷新管理.md', '/DESIGN.md', '/README.md']) {
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
  'public-types.ts': 0, 'source.ts': 1, 'core.ts': 2, 'store.ts': 3, 'vue.ts': 4, 'index.ts': 5,
}
// The root-contract rewrite left no same-layer or upward runtime edge: every module only imports
// from a lower layer, so the acknowledged list is empty on purpose (ADR-27).
const ACKNOWLEDGED_EDGES = []
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

// 11) `core.ts` has no class body worth reading top to bottom without its `═══` banners, and the
//     documented section list is the only map of them. The list drifted once under the previous
//     layout, so both documents must name the same sections in the same order.
const banners = [...read('/src/core.ts').matchAll(/═+ ([^═\n]+?) ═+/g)].map(match => match[1].trim())
check(banners.length > 0, '/src/core.ts', 'no section banners found')
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
  { claim: '配置非法的通知', anchor: 'U05', phrase: '配置快照读不出' },
  { claim: '参数编码', anchor: 'U15', phrase: '键排序' },
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
// out would only weaken (c), never fail it. `active` was missing until 2026-09-17 (ADR-50).
const INTERNAL_FIELDS = ['parameters', 'subscription', 'subscribers', 'waiters',
  'settledAt', 'entry', 'task', 'controller', 'wakeup', 'flushing', 'cleanup', 'disposed',
  'visible', 'buckets', 'handles', 'queue', 'running', 'snapshot', 'settle', 'active']
for (const field of INTERNAL_FIELDS) {
  check(!vocabulary.includes(field), '统一刷新管理.md §0',
    `§0 states outward meaning only, but names the internal field ${field} (DESIGN §3.3)`)
}

// 14) The README records the built artifact's size, and that number drifted three times because
//     nothing measured it (someone re-ran `pnpm build` and forgot the doc). Both recorded forms —
//     `22.33 kB，22330 字节` — must match `dist/index.js` when it exists; a clean checkout without
//     `dist/` prints a note and skips, so the gate never manufactures a signal. The gzip figure
//     `vite` prints is deliberately not recorded here: it has no reproducible definition in this
//     script (node zlib level 9 gives a different number), and an ungated number is what drifted.
const recordedSizes = [...read('/README.md').matchAll(/([\d.]+) kB，(\d+) 字节/g)]
check(recordedSizes.length >= 2, '/README.md', 'missing the built-artifact size in kB + 字节 form')
if (existsSync(`${root}/dist/index.js`)) {
  const bytes = statSync(`${root}/dist/index.js`).size
  for (const [, kilobytes, recorded] of recordedSizes) {
    check(kilobytes === (bytes / 1000).toFixed(2) && Number(recorded) === bytes, '/README.md',
      `dist/index.js size differs\n    documented: ${kilobytes} kB，${recorded} 字节\n    measured:   ${(bytes / 1000).toFixed(2)} kB，${bytes} 字节`)
  }
} else {
  console.log('[docs] dist/index.js is absent; the recorded artifact size was not re-measured (run pnpm build)')
}

// 15) Both normative documents name code symbols, and nothing checked that those names exist:
//     DESIGN once promised the type `DeliveryBarrier` and the method `cancelRefresh`, neither of
//     which ever existed in `src/`, and every gate stayed green. Two automatic checks, no curated
//     list to go stale:
//     (a) every backticked PascalCase token must occur somewhere in `src/` — acceptance ids
//         (`U13`, `B10`) and the trace-report labels are exempt, nothing else is;
//     (b) the Manager row in DESIGN §3.3 is the public-surface promise, so every method it names
//         must exist in `src/core.ts`.
//     ADR.md is excluded on purpose: it quotes historical names ("`OBSERVER_FAILED` 已不存在").
const DOC_SYMBOL_EXEMPT = new Set(['EVIDENCE', 'STATIC', 'PARTIAL', 'UNVERIFIED'])
const sourceText = modules.map(file => read(`/src/${file}`)).join('\n')
const documentedSymbols = new Set([...designText.matchAll(/`([A-Z][A-Za-z0-9]{2,})`/g)].map(match => match[1]))
for (const symbol of documentedSymbols) {
  if (/^[A-Z]\d/.test(symbol) || DOC_SYMBOL_EXEMPT.has(symbol)) continue
  check(new RegExp(`\\b${symbol}\\b`).test(sourceText), 'DESIGN.md / 统一刷新管理.md',
    `documented code symbol ${symbol} does not appear in src/`)
}
const coreRow = designText.split('\n').find(line => line.startsWith('| RefreshCore |'))
check(Boolean(coreRow), 'DESIGN.md §3.3', 'missing the RefreshCore ownership row')
if (coreRow) {
  const namedOperations = /外部只能走命名操作（([^）]*)）/.exec(coreRow)?.[1] ?? ''
  const promised = new Set([
    ...[...namedOperations.matchAll(/`([^`]+)`/g)].map(match => match[1]),
    ...[...coreRow.matchAll(/`([a-zA-Z][\w$]*)\(\)`/g)].map(match => match[1]),
  ])
  check(promised.size > 0, 'DESIGN.md §3.3', 'no named operations parsed from the RefreshCore row')
  const coreSource = read('/src/core.ts')
  for (const name of promised) {
    check(new RegExp(`\\b${name}\\s*\\(`).test(coreSource), 'DESIGN.md §3.3',
      `the RefreshCore row promises ${name}(), which src/core.ts does not define`)
  }
}

// 16) The export surface and the test totals are prose in three documents, and nothing measured them:
//     when the surface shrank from 8 public types to 7 and from two constant objects to one, four
//     numbers stayed wrong through five green deliveries — "8 个公共类型" in §7, "三个状态常量对象"
//     twice in DESIGN (contradicting its own §3.8), and README's "37 个用例（core 30）".
//     Nothing below is curated: counts and names come from `src/index.ts` and from the test files.
//     (a) every count stated in a document must equal the live number — surface sentences read the
//         entry, `N 个用例` and `` `tests/x.test.ts` N `` read the test files;
//     (b) every list that names the surface — §2's three rows and any `N 个X（…）` parenthesis — must
//         name exactly the exported symbols.
//     §4.1's "一个函数" is deliberately outside (a): only lines stating the public-type or
//     constant-object count are treated as surface sentences.
const identifier = token => /^[A-Za-z_$][\w$]*$/.test(token)
const valueExports = [...entry.matchAll(/^export \{([^}]*)\} from/gm)]
  .flatMap(match => match[1].split(',')).map(name => name.trim()).filter(Boolean)
const exported = {
  '函数': valueExports.filter(name => /^[a-z]/.test(name)),
  '状态常量对象': valueExports.filter(name => /^[A-Z]/.test(name)),
  '公共类型': [...entry.matchAll(/^export type \{([^}]*)\} from/gm)]
    .flatMap(match => match[1].split(',')).map(name => name.trim()).filter(Boolean),
}
const testCounts = new Map(readdirSync(`${root}/tests`).filter(name => name.endsWith('.test.ts'))
  .map(name => [name, (read(`/tests/${name}`).match(/^test\(/gm) ?? []).length]))
const testTotal = [...testCounts.values()].reduce((sum, value) => sum + value, 0)
const liveCount = kind => kind === '用例' ? testTotal : exported[kind].length
const CN_DIGITS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
const stated = raw => CN_DIGITS[raw] ?? Number(raw)
const sameNames = (left, right) => left.slice().sort().join(' ') === right.slice().sort().join(' ')
for (const [file, text] of [['/README.md', read('/README.md')], ['/DESIGN.md', designText], ['/统一刷新管理.md', design]]) {
  for (const line of text.split('\n')) {
    if (!/个公共类型|个状态常量对象/.test(line)) continue
    for (const [, raw, kind] of line.matchAll(/(\d+|[一二两三四五六七八九十])\s*个(正式函数|函数|状态常量对象|公共类型)/g)) {
      const label = kind === '正式函数' ? '函数' : kind
      check(stated(raw) === liveCount(label), file,
        `states "${raw} 个${kind}", but the entry exports ${liveCount(label)}`)
    }
  }
  for (const [, raw] of text.matchAll(/(\d+|[一二两三四五六七八九十])\s*个用例/g)) {
    check(stated(raw) === testTotal, file, `states "${raw} 个用例", but the test files declare ${testTotal}`)
  }
  for (const [, name, recorded] of text.matchAll(/`tests\/([\w.]+\.test\.ts)` (\d+)/g)) {
    check(testCounts.get(name) === Number(recorded), file,
      `states ${recorded} cases in ${name}, but it declares ${testCounts.get(name)}`)
  }
  for (const [, kind, inside] of text.matchAll(/[一二两三四五六七八九十\d]+\s*个(状态常量对象|公共类型|函数)（([^）]*)）/g)) {
    const named = [...inside.matchAll(/`([^`]+)`/g)].map(match => match[1]).filter(identifier)
    if (named.length) check(sameNames(named, exported[kind]), file,
      `the list after "个${kind}" is not the exported ${kind}\n    documented: ${named.join(' / ')}\n    exported:   ${exported[kind].join(' / ')}`)
  }
}
const apiRows = design.slice(design.indexOf('## 2. 公共 API 契约'), design.indexOf('### 2.1')).split('\n')
for (const [kind, head] of [['函数', '| 函数 |'], ['状态常量对象', '| 状态常量'], ['公共类型', '| 类型 |']]) {
  const row = apiRows.find(value => value.startsWith(head))
  if (!exported[kind].length) {
    // A kind the entry no longer exports must not keep a row (ADR-51 removed the last constant object).
    check(!row, '统一刷新管理.md §2', `the API list still has a ${kind} row, but the entry exports none`)
    continue
  }
  check(Boolean(row), '统一刷新管理.md §2', `missing the ${kind} row of the API list`)
  if (row) {
    const named = [...row.matchAll(/`([^`]+)`/g)].map(match => match[1]).filter(identifier)
    check(sameNames(named, exported[kind]), '统一刷新管理.md §2',
      `the ${kind} row is not the exported ${kind}\n    documented: ${named.join(' / ')}\n    exported:   ${exported[kind].join(' / ')}`)
  }
}

// 17) Retired vocabulary must not come back into the normative documents. ADR-46 removed the read
//     entry, ADR-48 `CancelReason`, ADR-51 `RefreshError` / `ErrorOrigin` and the caller-side
//     notification — yet two `caller` mentions survived inside the very rules that describe the
//     parameter boundary (U15 still promised "`rejected` ＋ 一次 `caller` 通知" for two commits).
//     #15 only sees backticked PascalCase symbols, so a lowercase retired name was invisible; that
//     is how an external review came to cite a notification channel that no longer exists.
//     §5 is excluded on purpose: it keeps delivery records that legitimately quote what past ADRs
//     removed, and ADR.md is not scanned at all for the same reason.
const RETIRED = ['caller', 'ErrorOrigin', 'CancelReason', 'RefreshError', 'readSnapshot', 'reported', 'INVALID_CONFIG_MESSAGE']
for (const [file, text] of [['/README.md', read('/README.md')], ['/DESIGN.md', designText],
  ['/统一刷新管理.md', design.slice(0, catalogueEnd)]]) {
  for (const term of RETIRED) {
    check(!text.includes(`\`${term}\``), file,
      `retired name \`${term}\` is back in the normative text (it no longer exists in src/; the history is in ADR.md)`)
  }
}

if (problems.length) {
  for (const problem of problems) console.error('[docs]', problem)
  process.exit(1)
}
// The leaf → test-title traceability report is printed, never enforced: a leaf absent from every
// test title is a review aid, not a defect, so it must not fail this gate.
console.log(execFileSync(process.execPath, [`${root}/scripts/trace-leaves.mjs`], { cwd: root, encoding: 'utf8' }).trimEnd())
console.log(`[docs] consistent: ${modules.length} modules, contract mirror, README metrics, `
  + `README artifact size, export-surface counts and API list, test totals, documented symbols, `
  + `retired names, `
  + `${declared.size} trigger anchors, capability blocks, `
  + `dependency direction, published entry, core sections, ${TOPIC_CITATIONS.length} topic citations, `
  + `${vocabularyRows.length} vocabulary rows, ${leaves.size} layered leaves, `
  + `${peerTypeEdges} peer type edges, ${backTypeEdges} type-only back edges`)
