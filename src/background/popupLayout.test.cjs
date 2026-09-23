// 方案 041：极简面板首帧定宽回归测试。UI tests live beside the existing tests because npm test scans this directory.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const postcss = require('postcss')
const { parse } = require('@vue/compiler-sfc')
const root = path.resolve(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
function inlineStyles(html) {
  const blocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1])
  assert.ok(blocks.length > 0, 'popup/index.html must keep an inline <style> block')
  return postcss.parse(blocks.join('\n'))
}
function decls(tree, selector) {
  const out = {}
  tree.walkRules((rule) => {
    if (!rule.selector.split(',').map((s) => s.trim()).includes(selector)) return
    rule.walkDecls((d) => { out[d.prop] = d.value })
  })
  return out
}
test('popup document fixes html/body width in inline CSS before any script or stylesheet runs', () => {
  const html = read('src/popup/index.html')
  const styleAt = html.indexOf('<style'), scriptAt = html.indexOf('<script'), linkAt = html.indexOf('<link')
  assert.ok(styleAt >= 0 && scriptAt > styleAt, 'inline <style> must precede the module script')
  assert.ok(linkAt < 0 || linkAt > styleAt, 'inline <style> must precede any <link>')
  const tree = inlineStyles(html)
  const width = decls(tree, ':root')['--popup-width']
  assert.match(width ?? '', /^\d+px$/, '--popup-width must be a px literal on :root')
  const px = parseInt(width, 10)
  assert.ok(px >= 25 && px <= 800, 'Chromium clamps popups to 25..800px wide')
  for (const selector of ['html', 'body']) {
    const d = decls(tree, selector)
    assert.equal(d.width, 'var(--popup-width)', `${selector} width`)
    assert.equal(d['min-width'], 'var(--popup-width)', `${selector} min-width`)
    assert.equal(d.margin, '0', `${selector} margin`)
  }
})
test('popup ships a static first-frame skeleton inside #app that Vue mount replaces', () => {
  const html = read('src/popup/index.html')
  const app = html.match(/<div id="app">([\s\S]*?)<\/div>\s*<script/)
  assert.ok(app && app[1].trim().length > 0, '#app must not be empty before mount')
  assert.match(app[1], /class="boot"/)
  assert.match(decls(inlineStyles(html), '.boot')['min-height'] ?? '', /^\d+px$/)
})
test('Popup.vue no longer owns a second hard-coded width (single source of truth)', () => {
  const { descriptor, errors } = parse(read('src/popup/Popup.vue'), { filename: 'Popup.vue' })
  assert.equal(errors.length, 0)
  const pop = {}
  postcss.parse(descriptor.styles[0].content).walkRules((rule) => {
    if (rule.selector === '.pop') rule.walkDecls((d) => { pop[d.prop] = d.value })
  })
  assert.equal(pop.width, '100%')
  assert.equal(pop['min-width'], undefined)
  assert.equal(pop['box-sizing'], 'border-box')
})
test('popup mounts PluginShell in compact mode; the shell has a lightweight initializing view; other entries unchanged', () => {
  assert.match(read('src/popup/main.ts'), /createApp\(PluginShell,\s*\{[^}]*\bcompact:\s*true/)
  const { descriptor, errors } = parse(read('src/shared/PluginShell.vue'), { filename: 'PluginShell.vue' })
  assert.equal(errors.length, 0)
  assert.match(descriptor.scriptSetup.content, /compact\?:\s*boolean/)
  const template = descriptor.template.content
  assert.match(template, /class="plugin-boot"/)
  assert.match(template, /v-if="compact && state\.effectiveState === 'initializing' && !error"/)
  assert.match(template, /<section v-else class="plugin-disabled">/)
  const css = descriptor.styles[0].content
  assert.match(css, /\.plugin-boot\{[^}]*min-height:120px/)
  assert.match(css, /\.plugin-error\{[^}]*overflow-wrap:anywhere/)
  for (const kind of ['options', 'sidepanel']) assert.doesNotMatch(read(`src/${kind}/main.ts`), /\bcompact\b/)
})
