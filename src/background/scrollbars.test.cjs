// UI tests live beside the existing tests because npm test currently scans this directory.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const postcss = require('postcss')
const root = path.resolve(__dirname, '../..')
const source = fs.readFileSync(path.join(root, 'src/shared/scrollbars.ts'), 'utf8')
const css = fs.readFileSync(path.join(root, 'public/scrollbars.css'), 'utf8')
const tree = postcss.parse(css)
function load(extra = {}) {
  const module = { exports: {} }
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  vm.runInNewContext(js, { module, exports: module.exports, console: { warn() {} }, ...extra })
  return module.exports.installScrollbarStyles
}
function fixture() {
  const classes = new Set(['theme-dark'])
  const links = []
  const classList = {
    add: (...items) => items.forEach((x) => classes.add(x)),
    remove: (...items) => items.forEach((x) => classes.delete(x)),
    toggle: (name, on) => on ? classes.add(name) : classes.delete(name),
  }
  const document = {
    documentElement: { classList },
    getElementById: (id) => links.find((l) => l.id === id),
    createElement: (tag) => {
      assert.equal(tag, 'link')
      const link = { events: {}, addEventListener: (type, fn) => { link.events[type] = fn }, remove: () => { const i = links.indexOf(link); if (i >= 0) links.splice(i, 1) } }
      return link
    },
    head: { appendChild: (link) => links.push(link) },
  }
  return { classes, links, document, chrome: { runtime: { getURL: (name) => 'chrome-extension://test/' + name } } }
}
test('scrollbar installer is idempotent and compact mode is reversible', () => {
  const env = fixture(), install = load(env)
  install(); install(); assert.equal(env.links.length, 1)
  assert.ok(env.classes.has('app-scrollbars')); assert.ok(env.classes.has('theme-dark'))
  install(true); assert.ok(env.classes.has('app-scrollbars-compact'))
  install(false); assert.ok(!env.classes.has('app-scrollbars-compact')); assert.equal(env.links.length, 1)
})
test('scrollbar CSS loads only from the extension origin', () => {
  const env = fixture(); load(env)()
  assert.equal(env.links[0].href, 'chrome-extension://test/scrollbars.css')
  assert.equal(env.links[0].rel, 'stylesheet')
})
test('CSS failure restores native scrolling without removing theme and permits retry', () => {
  const env = fixture(), install = load(env); install(true)
  env.links[0].events.error()
  assert.equal(env.links.length, 0); assert.ok(env.classes.has('theme-dark'))
  assert.ok(!env.classes.has('app-scrollbars')); assert.ok(!env.classes.has('app-scrollbars-compact'))
  install(); assert.equal(env.links.length, 1)
})
test('SSR or unavailable runtime is harmless', () => {
  assert.doesNotThrow(() => load()())
  const env = fixture(); assert.doesNotThrow(() => load({ document: env.document })())
  assert.equal(env.links.length, 0)
})
test('runtime URL failure cannot prevent page startup', () => {
  const env = fixture(); env.chrome.runtime.getURL = () => { throw Error('context invalidated') }
  assert.doesNotThrow(() => load(env)()); assert.equal(env.links.length, 0)
  assert.ok(!env.classes.has('app-scrollbars')); assert.ok(env.classes.has('theme-dark'))
})
function tokens(selector) {
  const values = {}
  tree.walkRules((rule) => { if (rule.selector === selector) rule.walkDecls((d) => { values[d.prop] = d.value }) })
  return values
}
function luminance(hex) {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722
}
test('all thumb states meet 3:1 against the three actual theme surfaces', () => {
  for (const [selector, backgrounds] of [
    ['html.app-scrollbars', ['#f4f5f9', '#ffffff', '#f7f8fc']],
    ['html.app-scrollbars.theme-dark', ['#2b2d31', '#313338', '#383a40']],
  ]) {
    const vars = tokens(selector)
    for (const key of ['--sb-thumb', '--sb-thumb-hover', '--sb-thumb-active']) {
      for (const bg of backgrounds) {
        const a = luminance(vars[key]), b = luminance(bg)
        assert.ok((Math.max(a, b) + .05) / (Math.min(a, b) + .05) >= 3, `${key} ${vars[key]} on ${bg}`)
      }
    }
  }
})
test('CSS is scoped, preserves layout, and confines drawing to fine pointer/non-forced colors', () => {
  assert.equal(tokens('html.app-scrollbars')['--sb-size'], '10px')
  assert.equal(tokens('html.app-scrollbars.app-scrollbars-compact')['--sb-size'], '8px')
  tree.walkRules((r) => {
    assert.ok(r.selector.split(',').every((s) => s.trim().startsWith('html.app-scrollbars')))
    r.walkDecls((d) => {
      assert.ok(!['overflow', 'overflow-x', 'overflow-y', 'scroll-behavior', 'animation', 'transition', 'position'].includes(d.prop))
      if (!d.prop.startsWith('--')) {
        let p = r.parent
        while (p && !(p.type === 'atrule' && p.name === 'media')) p = p.parent
        assert.ok(p && p.params.includes('forced-colors: none') && p.params.includes('pointer: fine'))
      }
    })
  })
  const supports = tree.nodes.flatMap((n) => n.nodes ?? []).find((n) => n.type === 'atrule' && n.name === 'supports')
  assert.ok(supports && supports.params === 'selector(::-webkit-scrollbar)')
  assert.match(supports.toString(), /scrollbar-width:\s*auto/)
  assert.match(supports.toString(), /scrollbar-color:\s*auto/)
})
test('all three entry points install styles before mounting; only popup is compact', () => {
  for (const kind of ['options', 'sidepanel', 'popup']) {
    const src = fs.readFileSync(path.join(root, `src/${kind}/main.ts`), 'utf8')
    const call = `installScrollbarStyles(${kind === 'popup'})`
    assert.ok(src.includes(call))
    assert.ok(src.indexOf(call) < src.indexOf('initTheme().finally'))
  }
})
test('README iframe document explicitly opts into the same local CSS', () => {
  const html = fs.readFileSync(path.join(root, 'public/README.html'), 'utf8')
  assert.match(html, /<html[^>]*class="app-scrollbars"/)
  assert.match(html, /<link rel="stylesheet" href="\.\/scrollbars\.css"/)
})
