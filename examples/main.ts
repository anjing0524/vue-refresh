/** 演示入口：`?test`／`?mode=controlled` 走集成验证台，其余走代表页面外壳。 */
import { mountHarness } from './harness'
import { mountShell } from './shell'
import type { HarnessBridge } from './harness'
import type { ShellBridge } from './shell'

declare global {
  interface Window {
    experiment: HarnessBridge
    pages: ShellBridge
  }
}

const params = new URLSearchParams(location.search)

if (params.has('test') || params.get('mode') === 'controlled') mountHarness()
else mountShell()
