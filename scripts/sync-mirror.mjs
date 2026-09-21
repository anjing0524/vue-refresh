#!/usr/bin/env node
/** 用 `src/public-types.ts`（去注释）重写《统一刷新管理.md》§2.2 的镜像块。改类型之后跑它。 */
import { writeMirror } from './mirror.mjs'
console.log(writeMirror() ? '[mirror] §2.2 已按 src/public-types.ts 重写' : '[mirror] §2.2 已是最新')
