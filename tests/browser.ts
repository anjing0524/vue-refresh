import { scenarios } from './scenarios'
import type { Driver } from './scenarios'

const frame = document.querySelector<HTMLIFrameElement>('#subject')!
const output = document.querySelector<HTMLPreElement>('#results')!
const button = document.querySelector<HTMLButtonElement>('#run')!
const api = () => frame.contentWindow!.experiment
const driver: Driver = {
  async open(path) {
    await new Promise<void>(resolve => { frame.onload = () => resolve(); frame.src = path })
  },
  async snapshot() { return api().snapshot() },
  async enable(name, value) { api().enable(name, value) },
  async resolve(id, price) { api().resolve(id, price) },
  async mutatePage(name, price) { api().mutatePage(name, price) },
  async refresh(name, symbol) { api().refresh(name, symbol) },
  async unmount() { api().unmount() },
  async requests() { return (await fetch('/__fixture/state')).json() },
  async release(id) { await fetch(`/__fixture/release/${id}`, { method: 'POST' }) },
  async price(name) { return frame.contentDocument!.querySelector(`[data-testid="price-${name}"]`)?.textContent ?? '' },
}
button.onclick = async () => {
  button.disabled = true
  output.textContent = ''
  for (const scenario of scenarios) {
    try {
      const reset = await fetch('/__fixture/reset', { method: 'POST', body: JSON.stringify({ manual: true }) })
      if (!reset.ok) throw new Error(`HTTP fixture reset failed: ${reset.status}`)
      await scenario.run(driver)
      output.textContent += `通过：${scenario.name}\n`
    } catch (error) {
      output.textContent += `失败：${scenario.name}\n${String(error)}\n`
    } finally {
      if (frame.contentWindow?.experiment) {
        api().unmount()
        for (const call of api().snapshot().calls) if (!call.finished) api().resolve(call.id, -999)
      }
      await new Promise<void>(resolve => { frame.onload = () => resolve(); frame.src = 'about:blank' })
    }
  }
  output.textContent += '运行结束；仅代表以上实验范围。'
  button.disabled = false
}
