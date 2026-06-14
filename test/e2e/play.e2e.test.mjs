// End-to-end gameplay test over the real stack: two Chromium pages join the
// same room and play a round. By default it boots a local `wrangler dev`; set
// E2E_BASE_URL=https://chooser.<acct>.workers.dev to run the exact same suite
// against the deployed production Worker instead.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { startServer } from './server.mjs'

async function press(page, id, fx, fy) {
  await page.evaluate(({ id, fx, fy }) => {
    const c = document.querySelector('#stage')
    c.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: id, clientX: fx * c.clientWidth, clientY: fy * c.clientHeight,
      bubbles: true, cancelable: true,
    }))
  }, { id, fx, fy })
}

const hasPeers = (page) => page.waitForFunction(
  () => document.querySelector('#peer-count')?.textContent.includes('2 device'),
  null, { timeout: 30000 })

const bannerShown = (page) => page.waitForFunction(
  () => !document.querySelector('#banner').hidden, null, { timeout: 20000 })

// True once the canvas has any non-transparent pixel — i.e. a finger is drawn.
const canvasHasInk = (page) => page.waitForFunction(() => {
  const c = document.querySelector('#stage')
  const { data } = c.getContext('2d').getImageData(0, 0, c.width, c.height)
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true
  return false
}, null, { timeout: 20000 })

describe('Chooser hosted — two players in a room', () => {
  // A unique room per run so a re-run never collides with a lingering DO.
  const ROOM = `E2E${Math.random().toString(36).slice(2, 6).toUpperCase()}`
  let server, browser, A, B

  before(async () => {
    server = process.env.E2E_BASE_URL
      ? { url: process.env.E2E_BASE_URL.replace(/\/$/, ''), close: async () => {} }
      : await startServer()
    browser = await chromium.launch()
    const url = `${server.url}/#${ROOM}`

    const open = async (name) => {
      const ctx = await browser.newContext()
      const page = await ctx.newPage()
      await page.addInitScript((n) => localStorage.setItem('chooser:name', n), name)
      await page.goto(url)
      return page
    }
    A = await open('Alice Apple')
    B = await open('Bob Banana')
  })

  after(async () => {
    await browser?.close()
    await server?.close()
  })

  test('both pages reach "2 devices"', async () => {
    await Promise.all([hasPeers(A), hasPeers(B)])
  })

  test('a finger on A renders as a remote finger on B', async () => {
    await press(A, 1, 0.3, 0.3)
    await canvasHasInk(B)
  })

  test('holding two fingers picks one winner both pages agree on', async () => {
    await press(A, 1, 0.3, 0.3)
    await press(B, 1, 0.7, 0.7)

    await Promise.all([bannerShown(A), bannerShown(B)])
    const [ba, bb] = await Promise.all([A.textContent('#banner'), B.textContent('#banner')])

    // Exactly one device sees itself chosen; the other names that same peer —
    // proving both resolved the identical winner from the server's seed and that
    // the winner's name propagated over the socket.
    const winners = [ba, bb].filter((t) => t.includes('You were chosen'))
    assert.equal(winners.length, 1, `expected one winner, got banners: "${ba}" | "${bb}"`)

    const [winPage, loserBanner] = ba.includes('You were chosen') ? [A, bb] : [B, ba]
    const winName = (await winPage.textContent('#name-pill')).trim()
    assert.equal(loserBanner.trim(), `${winName} was chosen`)
  })
})
