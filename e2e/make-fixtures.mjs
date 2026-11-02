// Two distinct PNG fixtures for phase2 (paste/drop/resize tests).
import { chromium } from 'playwright-core'
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' })
const page = await browser.newPage()
for (const [name, w, h, bg] of [['welcome', 1200, 800, '#c8a45c'], ['showcase', 900, 600, '#5c7fa8']]) {
  await page.setViewportSize({ width: w, height: h })
  await page.setContent(`<body style="margin:0;background:${bg};font:64px sans-serif;display:grid;place-items:center;height:100vh">${name}</body>`)
  await page.screenshot({ path: `fixtures/${name}.png` })
}
await browser.close()
