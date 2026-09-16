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
const claimed = new Set()
for (const title of titles) {
  for (const match of title.matchAll(/\b[A-Z]\d{2}[a-z]?\b/g)) claimed.add(match[0])
}

const uncovered = [...leaves].filter(id => !claimed.has(id)).sort()
const named = [...claimed].filter(id => leaves.has(id)).length
// `U01`–`U25` are §3 trigger anchors, not acceptance ids, so they are expected in test titles.
const dangling = [...claimed].filter(id => !leaves.has(id) && !/^U\d{1,3}$/.test(id)).sort()

console.log(`[trace] ${leaves.size} leaves, ${named} named by ${titles.length} test titles, `
  + `${uncovered.length} leaves with no test-title reference: ${uncovered.join(' ') || '-'}`)
if (dangling.length) {
  console.log(`[trace] named in a test title but not an acceptance leaf: ${dangling.join(' ')}`)
}

if (process.argv.includes('--map')) {
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
    const hit = sorted.filter(id => claimed.has(id))
    console.log(`[trace] ${domain}: ${anchors.join(' ')} -> ${sorted.length} leaves, ${hit.length} test-named`)
    console.log(`[trace]   ${sorted.map(id => (claimed.has(id) ? id : `${id}!`)).join(' ')}`)
  }
}
