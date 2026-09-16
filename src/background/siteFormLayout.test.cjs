const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { parse, compileTemplate } = require('@vue/compiler-sfc')
const postcss = require('postcss')
function component(name) {
  const filename = path.resolve(__dirname, '../options/components', name + '.vue')
  const source = fs.readFileSync(filename, 'utf8')
  const { descriptor, errors } = parse(source, { filename })
  assert.equal(errors.length, 0)
  return { descriptor, filename, source }
}
function element(node, klass) {
  if (node.type === 1 && node.props.some((p) => p.name === 'class' && p.value?.content.split(' ').includes(klass))) return node
  for (const child of node.children ?? []) { const found = element(child, klass); if (found) return found }
}
test('site form compiles and header/body/footer are siblings, keeping actions outside scroll area', () => {
  const { descriptor, filename } = component('SiteForm')
  assert.equal(compileTemplate({ source: descriptor.template.content, filename, id: 'layout-test' }).errors.length, 0)
  const modal = element(descriptor.template.ast, 'modal')
  const children = modal.children.filter((n) => n.type === 1)
  assert.deepEqual(children.map((n) => n.tag), ['header', 'div', 'footer'])
  assert.ok(element(children[1], 'editor-columns'))
  assert.ok(element(children[2], 'foot'))
  assert.ok(!element(children[1], 'foot'))
})
test('desktop grid has two columns and narrow viewport explicitly restores a single column', () => {
  const { descriptor } = component('SiteForm')
  const css = postcss.parse(descriptor.styles[0].content)
  let desktop = false, mobile = false, bodyScroll = false
  css.walkRules((rule) => {
    if (rule.selector === '.editor-columns') rule.walkDecls('grid-template-columns', (d) => {
      if (rule.parent.type === 'root') desktop = d.value === 'minmax(0, 1fr) minmax(0, 1fr)'
      if (rule.parent.type === 'atrule' && rule.parent.params === '(max-width: 760px)') mobile = d.value === 'minmax(0, 1fr)'
    })
    if (rule.selector === '.modal-body') rule.walkDecls('overflow-y', (d) => { bodyScroll = d.value === 'auto' })
  })
  assert.ok(desktop && mobile && bodyScroll)
})
test('site controls and save/permission flow bindings remain present with disclosure help', () => {
  const { descriptor } = component('SiteForm')
  const template = descriptor.template.content
  for (const name of ['name', 'baseUrl', 'adapter', 'currency', 'rechargeRate', 'rechargeDiscount']) {
    assert.ok(template.includes(`v-model="form.${name}"`))
  }
  assert.ok(template.includes('v-model="alertDrafts"'))
  assert.ok(template.includes(':disabled="submitting" @click="handleSubmit"'))
  assert.equal((template.match(/<details class="f-hint">/g) ?? []).length, 3)
})
test('alert fields are paired, explanations retained once, with no nested rule scroller', () => {
  const { descriptor, filename } = component('BalanceAlertEditor')
  assert.equal(compileTemplate({ source: descriptor.template.content, filename, id: 'alerts-layout-test' }).errors.length, 0)
  const template = descriptor.template.content
  assert.ok(template.includes('class="alert-fields"'))
  assert.ok(template.includes('<details class="alerts-guide">'))
  assert.equal((template.match(/首次采集、修改阈值或重新启用后/g) ?? []).length, 1)
  assert.ok(template.includes('@click="add"') && template.includes('@click="remove(rule.id)"'))
  assert.doesNotMatch(descriptor.styles[0].content, /overflow(?:-y)?:\s*(auto|scroll)/)
})
