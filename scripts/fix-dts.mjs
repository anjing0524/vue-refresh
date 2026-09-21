// Declaration post-processing, run at the end of `pnpm build`.
//
// The library bundles to a single `dist/index.js`, but tsc emits one `.d.ts` per source module and
// keeps the `.ts` specifier that `allowImportingTsExtensions` permits in-repo. A consumer cannot set
// that flag on the declared TS 4.9 baseline, so the specifiers are rewritten to `.js`: TypeScript
// resolves `./app.js` to the sibling `./app.d.ts`, which is exactly the emitted file. Nothing points
// at a `dist/app.js` at runtime, because the bundle is the only emitted JavaScript.
//
// 产物形态就在这里断言：本脚本只看刚生成的 `dist/`，不会被过期的构建骗过。
// 入口侧的 `export type *` 禁令在源码里守着（TS 5.0+ 才有的语法），与构建状态无关。
//
// Usage: node scripts/fix-dts.mjs
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const files = readdirSync(dist).filter(name => name.endsWith('.d.ts'))
let rewritten = 0
for (const name of files) {
  const path = dist + name
  const text = readFileSync(path, 'utf8')
  const next = text.replace(/(from\s+['"])(\.\/[^'"]+)\.ts(['"])/g, '$1$2.js$3')
  if (next !== text) {
    writeFileSync(path, next)
    rewritten++
  }
}

const problems = []
if (files.length === 0) problems.push('dist/ has no declaration files; run tsc -p tsconfig.lib.json first')
for (const name of files) {
  const text = readFileSync(dist + name, 'utf8')
  if (/^\s*export\s+type\s+\*/m.test(text)) {
    problems.push(`dist/${name}: uses export type * (requires TS 5.0+)`)
  }
  const specifier = /(?:from|import)\s+['"]\.\/[^'"]+\.ts['"]/.exec(text)
  if (specifier) problems.push(`dist/${name}: keeps a .ts specifier (${specifier[0]})`)
}
if (problems.length) {
  for (const problem of problems) console.error('[dts]', problem)
  process.exit(1)
}
console.log(`[dts] ${files.length} declaration files checked, ${rewritten} rewritten, shape asserted`)
