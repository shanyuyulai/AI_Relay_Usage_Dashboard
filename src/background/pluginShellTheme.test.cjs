// 方案 042：PluginShell 配色必须只使用 theme.css 中真实存在的令牌，且 popup 文档 body 具备主题基线。
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const postcss = require('postcss')
const { parse } = require('@vue/compiler-sfc')
const root = path.resolve(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')
const theme = postcss.parse(read('src/styles/theme.css'))
function tokens(selector) {
  const values = {}
  theme.walkRules((rule) => { if (rule.selector === selector) rule.walkDecls((d) => { values[d.prop] = d.value }) })
  return values
}
function shellStyles() {
  const { descriptor, errors } = parse(read('src/shared/PluginShell.vue'), { filename: 'PluginShell.vue' })
  assert.equal(errors.length, 0)
  return postcss.parse(descriptor.styles[0].content)
}
function rule(tree, selector) {
  const out = {}
  tree.walkRules((r) => {
    if (!r.selector.split(',').map((s) => s.trim()).includes(selector)) return
    r.walkDecls((d) => { out[d.prop] = d.value })
  })
  return out
}
test('every CSS variable PluginShell references is defined in theme.css (no dead tokens like --text-primary)', () => {
  const defined = new Set(Object.keys(tokens(':root')))
  assert.ok(defined.has('--text') && defined.has('--sub') && defined.has('--panel'))
  const used = new Set()
  shellStyles().walkDecls((d) => { for (const m of d.value.matchAll(/var\((--[\w-]+)/g)) used.add(m[1]) })
  assert.ok(used.size > 0)
  for (const name of used) assert.ok(defined.has(name), `${name} is referenced by PluginShell.vue but not defined in theme.css`)
})
test('PluginShell text, secondary text and error colors follow the theme tokens', () => {
  const tree = shellStyles()
  assert.match(rule(tree, '.plugin-shell').color ?? '', /^var\(--text[,)]/)
  assert.match(rule(tree, '.plugin-note').color ?? '', /^var\(--sub[,)]/)
  assert.match(rule(tree, '.plugin-boot').color ?? '', /^var\(--sub[,)]/)
  assert.match(rule(tree, '.plugin-error').color ?? '', /^var\(--err[,)]/)
  assert.equal(rule(tree, '.plugin-note').opacity, undefined)
})
test('popup document gives body the same themed baseline options/sidepanel get from their App.vue', () => {
  const html = read('src/popup/index.html')
  const blocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1])
  const tree = postcss.parse(blocks.join('\n'))
  const body = rule(tree, 'body')
  assert.equal(body.color, 'var(--text)')
  assert.equal(body.background, 'var(--panel)')
  assert.match(body['font-family'] ?? '', /system-ui/)
  assert.match(rule(tree, '.boot').color ?? '', /^var\(--sub[,)]/)
})
function luminance(hex) {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722
}
function contrast(a, b) {
  const la = luminance(a), lb = luminance(b)
  return (Math.max(la, lb) + .05) / (Math.min(la, lb) + .05)
}
test('theme tokens keep readable text on the panel surface in both light and dark themes', () => {
  for (const selector of [':root', 'html.theme-dark']) {
    const t = tokens(selector)
    for (const key of ['--text', '--sub', '--panel']) assert.match(t[key] ?? '', /^#[0-9a-f]{6}$/i, `${selector} ${key}`)
    assert.ok(contrast(t['--text'], t['--panel']) >= 4.5, `${selector}: --text on --panel`)
    assert.ok(contrast(t['--sub'], t['--panel']) >= 3, `${selector}: --sub on --panel`)
  }
})
