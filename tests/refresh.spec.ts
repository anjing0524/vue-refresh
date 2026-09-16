import { test } from '@playwright/test'
import { scenarios } from './scenarios'
import type { Driver } from './scenarios'

test.beforeEach(async ({ request, page }) => {
  await request.post('/__fixture/reset', { data: { manual: true } })
  page.on('pageerror', error => { throw error })
})
test.afterEach(async ({ page }) => {
  await page.evaluate(() => {
    if (!window.experiment) return
    window.experiment.unmount()
    for (const call of window.experiment.snapshot().calls) {
      if (!call.finished) window.experiment.resolve(call.id, -999)
    }
  })
})
for (const scenario of scenarios) {
  test(scenario.name, async ({ page, request }) => {
    const driver: Driver = {
      async open(path) { await page.goto(path) },
      snapshot: () => page.evaluate(() => window.experiment.snapshot()),
      enable: (name, value) => page.evaluate(({ name, value }) => window.experiment.enable(name, value), { name, value }),
      resolve: (id, price) => page.evaluate(({ id, price }) => window.experiment.resolve(id, price), { id, price }),
      mutatePage: (name, price) => page.evaluate(({ name, price }) => window.experiment.mutatePage(name, price), { name, price }),
      refresh: (name, symbol) => page.evaluate(({ name, symbol }) => window.experiment.refresh(name, symbol), { name, symbol }),
      nestedOuter: shown => page.evaluate(value => window.experiment.nestedOuter(value), shown),
      visibility: hidden => page.evaluate(value => window.experiment.visibility(value), hidden),
      unmount: () => page.evaluate(() => window.experiment.unmount()),
      async requests() { return (await request.get('/__fixture/state')).json() },
      async release(id) { await request.post(`/__fixture/release/${id}`) },
      price: name => page.getByTestId(`price-${name}`).innerText(),
    }
    await scenario.run(driver)
  })
}
