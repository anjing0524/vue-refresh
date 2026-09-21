#!/usr/bin/env node
/**
 * 门禁自检：门禁本身也会坏。
 *
 * 每一条规则都用一次定向注入来验活——把一处违反写进对应文件，跑 `scripts/check-docs.mjs`，
 * 要求它**红**，然后原样恢复。规则存在的意义是「能被违反时拦住」，只跑一遍绿不能证明这一点：
 * ADR-113 发现判分块曾经排在规则前面，第 18 组因此从落地起就是死代码，而门禁一直显示绿。
 *
 * 用法：`node scripts/check-docs.selftest.mjs`（会临时改写文件，跑完恢复；请勿在并行任务里跑）
 * 退出码 0 ＝ 所有注入都把门禁打红了；非 0 会指出哪一条没红。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GATE = resolve(root, 'scripts/check-docs.mjs')

/** 每条：规则号、文件、把 find 换成 replace、说明。 */
const CASES = [
  [1, 'DESIGN.md', 'store.ts                   结果表', 'ghost.ts                   幽灵模块', '模块清单必须等于 src 的实际文件'],
  [3, '统一刷新管理.md', 'export type ReadonlySnapshot', 'export type ReadonlySnapshotX', '§2.2 镜像必须与 public-types.ts 逐字一致'],
  [4, 'README.md', '7 个源文件、814 行', '7 个源文件、815 行', 'README 的度量行必须等于实测'],
  [5, '统一刷新管理.md', '### 3.6 R6 隔离与工程边界', '### 3.5 R6 隔离与工程边界', '章节编号必须自洽（不重号）'],
  [6, '统一刷新管理.md', '判定：A11、A12、A13、A21', '判定：A11、A12、A13', '规则与验收的双向追溯必须完整'],
  [7, 'DESIGN.md', '> 需求：R3、U11–U13、G7、G11', '> 需求：R3、U99、G7、G11', '引用的锚点必须真有落点'],
  [8, '统一刷新管理.md', '| [行为] A12 |', '| A12 |', '每片叶子必须带归属前缀'],
  [9, 'src/public-types.ts', "import type { App, Ref } from 'vue'", "import { identityOf } from './core.ts'\nimport type { App, Ref } from 'vue'", '运行期依赖边必须严格向下'],
  [10, 'src/index.ts', 'export type {', "export type * from './public-types.ts'\nexport type {", '入口不得用 TS 5.0 的 export type *'],
  [12, '统一刷新管理.md', '键排序', '键的排序', '主题引用的锚点必须仍带那个主题（跨多行条文）'],
  [13, '统一刷新管理.md', '| 环境允许 |', '| 环境允许X |', '§0 的词必须是正文真的在用的词'],
  [15, 'DESIGN.md', '一条结果只写一格', '一条结果只写一格（见 `GhostSymbol`）', '文档提到的代码符号必须真在 src 里'],
  [16, 'DESIGN.md', '包入口（两个函数与 6 个公共类型', '包入口（两个函数与 7 个公共类型', '写死的导出面计数必须等于实测'],
  [17, 'DESIGN.md', '结果只住结果表（唯一真值）', '结果只住结果表（唯一真值，旧名 `readSnapshot`）', '退役的名字不得回到规范文本'],
  [18, '统一刷新管理.md', '规则以**能力域**为阅读单位', '需求：规则以**能力域**为阅读单位', '§3 正文不得出现退役词'],
  [19, 'DESIGN.md', '> 需求：R6、U18、G04\n', '', '每个设计节必须指回需求'],
  [20, '统一刷新管理.md', '参数编码的行为规则见 §3（U15）。\n', '', '主题引用被删掉时也必须报（否则承诺失去落点）'],
]

const runGate = () => {
  try {
    execFileSync(process.execPath, [GATE], { cwd: root, encoding: 'utf8', stdio: 'pipe' })
    return 0
  } catch (error) {
    return error.status ?? 1
  }
}

let failed = 0
for (const [rule, file, find, replace, why] of CASES) {
  const path = resolve(root, file)
  const original = readFileSync(path, 'utf8')
  if (!original.includes(find)) {
    console.log(`[自检] 规则 ${rule} 的注入锚点没找到，用例本身失效：${file}「${find.slice(0, 30)}…」`)
    failed += 1
    continue
  }
  try {
    writeFileSync(path, original.replace(find, replace))
    const status = runGate()
    if (status === 0) {
      console.log(`[自检] 规则 ${rule} 没红（注入未生效或规则是死代码）：${why}`)
      failed += 1
    } else {
      console.log(`[自检] 规则 ${rule} 通过：注入后门禁红（${why}）`)
    }
  } finally {
    writeFileSync(path, original)
  }
}
const clean = runGate()
if (clean !== 0) {
  console.log('[自检] 恢复之后门禁仍红——自检没把文件还原干净')
  failed += 1
} else {
  console.log('[自检] 恢复之后门禁绿')
}
console.log(failed === 0 ? `[自检] ${CASES.length} 条规则全部能被违反时拦住` : `[自检] ${failed} 项没通过`)
process.exit(failed === 0 ? 0 : 1)
