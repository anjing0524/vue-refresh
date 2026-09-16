// Source-only metrics. Nested functions are measured independently, never twice.
// Without arguments it prints the measurement as JSON (that is what check-docs consumes).
// With --write it also rewrites the README metrics row from the same measurement, so the row is
// never hand-copied: `pnpm complexity --write`.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { parse } from '@babel/parser'

const functionTypes = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod'])
const decisions = new Set(['IfStatement', 'ForStatement', 'ForOfStatement', 'ForInStatement', 'WhileStatement', 'DoWhileStatement', 'CatchClause', 'ConditionalExpression'])
// Walk src/ recursively so subdirectories are measured too.
function sourceFiles(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sourceFiles(full))
    else if (entry.name.endsWith('.ts')) found.push(full)
  }
  return found.sort()
}
const files = sourceFiles('src').map(path => {
  const file = relative('src', path).split(sep).join('/')
  const text = readFileSync(path, 'utf8')
  const ast = parse(text, { sourceType: 'module', plugins: ['typescript'], tokens: true })
  const codeLines = new Set()
  for (const token of ast.tokens) {
    if (typeof token.type === 'string' || token.type.label === 'eof') continue
    for (let line = token.loc.start.line; line <= token.loc.end.line; line++) codeLines.add(line)
  }
  const functions = []
  function visit(node, parent, owner, nesting = 0) {
    if (!node || typeof node !== 'object' || !node.type) return
    if (functionTypes.has(node.type)) {
      owner = { name: node.id?.name ?? node.key?.name ?? parent?.id?.name ?? parent?.key?.name ?? `callback@${node.loc.start.line}`,
        line: node.loc.start.line, lines: node.loc.end.line - node.loc.start.line + 1, branches: 0, shortCircuits: 0, maxNesting: 0 }
      functions.push(owner)
      nesting = 0
    }
    let nextNesting = nesting
    if (owner) {
      if (decisions.has(node.type) || (node.type === 'SwitchCase' && node.test)) {
        owner.branches++
        nextNesting++
        owner.maxNesting = Math.max(owner.maxNesting, nextNesting)
      }
      if (node.type === 'LogicalExpression' || (node.type.startsWith('Optional') && node.optional)) owner.shortCircuits++
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'tokens', 'comments', 'leadingComments', 'trailingComments', 'innerComments'].includes(key)) continue
      if (Array.isArray(value)) for (const child of value) visit(child, node, owner, nextNesting)
      else if (value && typeof value === 'object') visit(value, node, owner, nextNesting)
    }
  }
  visit(ast)
  for (const fn of functions) { fn.ccn = 1 + fn.branches; fn.extended = fn.ccn + fn.shortCircuits }
  return { file, lines: text.trimEnd().split('\n').length, codeLines: codeLines.size,
    branches: functions.reduce((n, fn) => n + fn.branches, 0),
    shortCircuits: functions.reduce((n, fn) => n + fn.shortCircuits, 0),
    maxCCN: Math.max(0, ...functions.map(fn => fn.ccn)), maxExtended: Math.max(0, ...functions.map(fn => fn.extended)), functions }
})
const totals = [
  files.length,
  files.reduce((sum, file) => sum + file.lines, 0),
  files.reduce((sum, file) => sum + file.branches, 0),
  Math.max(...files.map(file => file.maxCCN)),
]
if (process.argv.includes('--write')) {
  const path = new URL('../README.md', import.meta.url)
  const row = `| pnpm complexity | ${totals[0]} 个源文件、${totals[1]} 行、${totals[2]} 个结构分支、最大函数圈复杂度 ${totals[3]} |`
  const text = readFileSync(path, 'utf8')
  if (!text.includes('pnpm complexity |')) throw new Error('README.md has no pnpm complexity row to rewrite')
  writeFileSync(path, text.split('\n').map(line => line.includes('pnpm complexity |') ? row : line).join('\n'))
  console.log(`[metrics] README row rewritten: ${row}`)
}
console.log(JSON.stringify({ convention: 'CCN=1+if/loop/catch/ternary/nondefault-case; extended adds logical and optional short circuits. Imports/types count as code lines. No dependency/test code.', files }, null, 2))
