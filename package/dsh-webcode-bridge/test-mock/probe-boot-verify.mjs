import { chromium } from 'playwright-core'

const URL = process.argv[2]
const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--no-sandbox'],
})
const page = await browser.newPage()
const errors = []
const logs = []
page.on('console', m => {
  const t = m.text()
  logs.push(`[${m.type()}] ${t}`)
  if (m.type() === 'error') errors.push(t)
})
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message))

await page.goto(URL, { waitUntil: 'load', timeout: 90000 })
await page.waitForTimeout(20000)

const bootErr = errors.filter(e => /web boot|did not activate|waiting for service/.test(e))
console.log('=== BOOT ERRORS ===')
console.log(bootErr.length ? bootErr.join('\n') : '(none)')
console.log('=== ALL ERRORS (first 25) ===')
console.log(errors.slice(0, 25).join('\n') || '(none)')
const dom = await page.evaluate(() => ({
  root: document.querySelector('#root')?.children.length ?? -1,
  bodyLen: document.body.innerHTML.length,
}))
console.log('=== DOM ===', JSON.stringify(dom))
await browser.close()
