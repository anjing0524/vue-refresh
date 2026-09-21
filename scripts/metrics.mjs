#!/usr/bin/env node
/**
 * 现算度量：用例数（按测试文件分片）、`src/` 的行数与分支、`dist/index.js` 的体积。
 *
 * 这些数字以前手抄在 README 里，于是需要一条门禁规则盯着它们别走样——**加副本就得加规则**。
 * 现在 README 不写死它们，要看就跑这条命令；`check-docs` 只保留复杂度那一行（由 `complexity --write` 生成）的兜底。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testFiles = readdirSync(resolve(root, 'tests')).filter(name => name.endsWith('.test.ts')).sort()
const tests = testFiles.map(name => [name, (readFileSync(resolve(root, 'tests', name), 'utf8').match(/^test\(/gm) ?? []).length])
const total = tests.reduce((sum, [, count]) => sum + count, 0)
const files = JSON.parse(execFileSync(process.execPath, [resolve(root, 'scripts/complexity.mjs')], { cwd: root, encoding: 'utf8' })).files
const lines = files.reduce((sum, file) => sum + file.lines, 0)
const branches = files.reduce((sum, file) => sum + file.branches, 0)
const maxCcn = Math.max(...files.map(file => file.maxCCN))

console.log(`[metrics] 用例：${total}（${tests.map(([name, count]) => `${name.replace('.test.ts', '')} ${count}`).join('、')}）`)
console.log(`[metrics] src/：${files.length} 个文件、${lines} 行、${branches} 个结构分支、最大函数圈复杂度 ${maxCcn}`)
const dist = resolve(root, 'dist/index.js')
console.log(existsSync(dist)
  ? `[metrics] dist/index.js：${statSync(dist).size} 字节`
  : '[metrics] dist/index.js 不存在（先跑 pnpm build）')
