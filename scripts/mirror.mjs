/**
 * §2.2 契约镜像的唯一来源：`src/public-types.ts`（去注释）。
 *
 * 规格 §2.2 里那份 TypeScript 块是**副本**——副本就得有人写。以前是人手抄，于是需要一条门禁盯着它别走样；
 * 现在由 `pnpm sync:mirror` 写（`scripts/sync-mirror.mjs`），`check-docs` 第 3 组仍比对，当兜底。
 * 去注释的实现只此一份：门禁与生成器都从这里取，避免「为了盯副本再抄一份逻辑」。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SPEC = resolve(root, '统一刷新管理.md')
export const SOURCE = resolve(root, 'src/public-types.ts')
const MIRROR = /(### 2\.2 完整类型与状态取值[\s\S]*?```ts\n)([\s\S]*?)(```)/

/** 丢掉纯注释内容：JSDoc 可以两边自由生长。 */
export function stripComments(text) {
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

/** 源码侧应有的镜像块（字符串）。 */
export const contractBlock = () => stripComments(readFileSync(SOURCE, 'utf8')).join('\n')

/** 规格侧当前的镜像块（字符串或 null）。 */
export const mirrorBlock = spec => {
  const match = MIRROR.exec(spec)
  return match === null ? null : match[2]
}

/** 把规格 §2.2 的镜像块重写成源码侧的版本；返回是否发生了改写。 */
export function writeMirror() {
  const spec = readFileSync(SPEC, 'utf8')
  const next = spec.replace(MIRROR, (_all, head, _body, tail) => `${head}${contractBlock()}\n${tail}`)
  if (next === spec) return false
  writeFileSync(SPEC, next)
  return true
}
