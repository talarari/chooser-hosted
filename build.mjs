// Builds the static client into public/, which the Worker serves via the
// Static Assets binding. The whole client module graph (app code + shared game
// logic) is bundled into one file referenced with a commit-stamped URL, so a
// deploy can never serve a mix of cached old and new modules to one browser.
import { execSync } from 'node:child_process'
import { build } from 'esbuild'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const out = 'public'

let stamp
try {
  stamp = execSync('git rev-parse --short HEAD').toString().trim()
} catch {
  stamp = Date.now().toString(36)
}

rmSync(out, { recursive: true, force: true })
mkdirSync(out)

await build({
  entryPoints: ['client/main.ts'],
  bundle: true,
  format: 'esm',
  minify: true,
  outfile: `${out}/app.js`,
  target: 'es2022',
})

for (const file of ['styles.css', 'manifest.json', 'icon.svg']) {
  cpSync(`client/${file}`, `${out}/${file}`)
}

const sw = readFileSync('client/sw.js', 'utf8').replaceAll('__BUILD_VERSION__', stamp)
if (sw.includes('__BUILD_VERSION__')) throw new Error('service worker stamping failed')
writeFileSync(`${out}/sw.js`, sw)

const html = readFileSync('client/index.html', 'utf8')
  .replace('src="app.js"', `src="app.js?v=${stamp}"`)
  .replace('href="styles.css"', `href="styles.css?v=${stamp}"`)
if (!html.includes(`v=${stamp}`)) throw new Error('asset stamping failed — check index.html references')
writeFileSync(`${out}/index.html`, html)

console.log(`built ${out}/ (v=${stamp})`)
