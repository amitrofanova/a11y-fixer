import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { planApply } from '../../src/core/apply'
import { analyzeVueFiles } from '../../src/core/static'
import type { Issue } from '../../src/core/types'
import { createVueProject } from '../support/vueProject'

const versions = { vuetify: '3.13.7', quasar: '2.35.5', '@nuxt/ui': '4.12.2' }
const vuetify = `import { VBtn, VImg } from 'vuetify/components'\n`
const quasar = `import { QBtn, QImg } from 'quasar'\n`
const nuxt = `import { UButton } from '@nuxt/ui'\n`

test('static analysis recognizes verified Vuetify, Quasar, and Nuxt UI components', () => {
  const project = createVueProject({
    'icon-button.vue': sfc(vuetify, '<main><VBtn icon="mdi-menu" /></main>'),
    'text-prop.vue': sfc(vuetify, '<main><VBtn text="Save" /></main>'),
    'icon-and-text.vue': sfc(vuetify, '<main><VBtn icon="mdi-menu" text="Save" /></main>'),
    'boolean-text.vue': sfc(vuetify, '<main><VBtn text /></main>'),
    'slot-text.vue': sfc(vuetify, '<main><VBtn>Save</VBtn></main>'),
    'aria.vue': sfc(vuetify, '<main><VBtn icon="mdi-menu" aria-label="Menu" /></main>'),
    'title.vue': sfc(vuetify, '<main><VBtn icon="mdi-menu" title="Menu" /></main>'),
    'href.vue': sfc(vuetify, '<main><VBtn href="/a" icon="mdi-menu" /></main>'),
    'empty-href.vue': sfc(vuetify, '<main><VBtn href="" icon="mdi-menu" /></main>'),
    'to.vue': sfc(vuetify, '<main><VBtn to="/a" icon="mdi-menu" /></main>'),
    'kebab.vue': sfc(vuetify, '<main><v-btn icon="mdi-menu" /></main>'),
    'alias.vue': sfc(`import { VBtn as MenuButton } from 'vuetify/components'\n`, '<main><MenuButton icon="mdi-menu" /></main>'),
    'default-import.vue': sfc(`import VBtn from 'vuetify/components/VBtn'\n`, '<main><VBtn icon="mdi-menu" /></main>'),
    'label-attr.vue': sfc(vuetify, '<main><VBtn label="Save" /></main>'),
    'missing-image.vue': sfc(vuetify, '<main><VImg src="/a.png" /></main>'),
    'empty-alt.vue': sfc(vuetify, '<main><VImg src="/a.png" alt="" /></main>'),
    'named-image.vue': sfc(vuetify, '<main><VImg src="/a.png" alt="Cat" /></main>'),
    'bound-image.vue': sfc(vuetify, '<main><VImg src="/a.png" :alt="name" /></main>'),
    'presentation.vue': sfc(vuetify, '<main><VImg src="/a.png" role="presentation" /></main>'),
    'root-image.vue': sfc(vuetify, '<VImg src="/a.png" />'),
    'q-icon.vue': sfc(quasar, '<main><QBtn icon="menu" /></main>'),
    'q-label.vue': sfc(quasar, '<main><QBtn label="Save" /></main>'),
    'q-zero.vue': sfc(quasar, '<main><QBtn label="0" /></main>'),
    'q-blank.vue': sfc(quasar, '<main><QBtn label="   " icon="menu" /></main>'),
    'q-tooltip.vue': sfc(quasar, '<main><QBtn icon="menu"><QTooltip>Hint</QTooltip></QBtn></main>'),
    'q-labelled-tooltip.vue': sfc(quasar, '<main><QBtn label="Save"><QTooltip>Hint</QTooltip></QBtn></main>'),
    'q-href.vue': sfc(quasar, '<main><QBtn href="/a" icon="menu" /></main>'),
    'q-anchor.vue': sfc(quasar, '<main><QBtn type="a" icon="menu" /></main>'),
    'q-image.vue': sfc(quasar, '<main><QImg src="/a.png" /></main>'),
    'q-image-alt.vue': sfc(quasar, '<main><QImg src="/a.png" alt="" /></main>'),
    'u-icon.vue': sfc(nuxt, '<main><UButton icon="i-lucide-search" /></main>'),
    'u-label.vue': sfc(nuxt, '<main><UButton label="Save" /></main>'),
    'u-empty-label.vue': sfc(nuxt, '<main><UButton label="" icon="i-lucide-search" /></main>'),
    'u-slot.vue': sfc(nuxt, '<main><UButton label="Save"><UIcon name="x" /></UButton></main>'),
    'u-leading.vue': sfc(nuxt, '<main><UButton label="Save"><template #leading>x</template></UButton></main>'),
    'u-link.vue': sfc(nuxt, '<main><UButton to="/a" icon="i-lucide-search" /></main>'),
    'dynamic-label.vue': sfc(quasar, '<main><QBtn :label="name" /></main>'),
    'dynamic-aria.vue': sfc(vuetify, '<main><VBtn :aria-label="name" /></main>'),
    'expression.vue': sfc(vuetify, '<main><VBtn>{{ name }}</VBtn></main>'),
    'slot-child.vue': sfc(vuetify, '<main><VBtn><Widget /></VBtn></main>'),
    'html.vue': sfc(vuetify, '<main><VBtn v-html="name" /></main>'),
    'bare.vue': sfc(vuetify, '<main><VBtn v-bind="attrs" /></main>'),
    'repeat.vue': sfc(vuetify, '<main><VBtn v-for="item in items" :key="item" icon="mdi-menu" /></main>'),
    'root-button.vue': sfc(vuetify, '<VBtn icon="mdi-menu" />'),
    'unknown.vue': sfc(vuetify, '<main><SomeWidget /><VBtn icon="mdi-menu" /></main>'),
    'native.vue': sfc(vuetify, '<main><img src="/a.png" /><button><VBtn icon="mdi-menu" /></button></main>'),
    'q-tab.vue': sfc(quasar, '<main><QBtn icon="menu" tabindex="3" /></main>'),
    'v-tab.vue': sfc(vuetify, '<main><VBtn icon="mdi-menu" tabindex="3" /></main>'),
    'u-tab.vue': sfc(nuxt, '<main><UButton icon="i-lucide-search" tabindex="3" /></main>'),
    'v-image-tab.vue': sfc(vuetify, '<main><VImg src="/a.png" alt="Cat" tabindex="3" /></main>'),
  }, versions)
  try {
    const files = fs.readdirSync(project.root).filter((name) => name.endsWith('.vue'))
    const result = analyzeVueFiles(project.root, files.map((name) => path.join(project.root, name)), 'ru')
    assert.deepEqual(result.errors, [])

    expectIssue(result.issues, 'icon-button.vue', { ruleId: 'button-name', tab: 'manual', source: '<VBtn icon="mdi-menu"' })
    expectIssue(result.issues, 'icon-and-text.vue', { ruleId: 'button-name', tab: 'manual', source: '<VBtn icon="mdi-menu"' })
    expectIssue(result.issues, 'href.vue', { ruleId: 'link-name', tab: 'manual', source: '<VBtn href="/a"' })
    expectIssue(result.issues, 'empty-href.vue', { ruleId: 'button-name', tab: 'manual' })
    expectIssue(result.issues, 'to.vue', { ruleId: 'link-name', tab: 'manual' })
    expectIssue(result.issues, 'kebab.vue', { ruleId: 'button-name', tab: 'manual', source: '<v-btn' })
    expectIssue(result.issues, 'alias.vue', { ruleId: 'button-name', tab: 'manual', source: '<MenuButton' })
    expectIssue(result.issues, 'default-import.vue', { ruleId: 'button-name', tab: 'manual' })
    expectIssue(result.issues, 'label-attr.vue', { ruleId: 'button-name', tab: 'manual' })
    expectIssue(result.issues, 'missing-image.vue', { ruleId: 'image-alt', tab: 'manual', source: '<VImg' })
    expectIssue(result.issues, 'bound-image.vue', { ruleId: 'image-alt', tab: 'ambiguous', reason: 'dynamic-attribute' })
    expectIssue(result.issues, 'presentation.vue', { ruleId: 'image-alt', tab: 'manual' })
    expectIssue(result.issues, 'root-image.vue', { ruleId: 'image-alt', tab: 'ambiguous', reason: 'fallthrough' })
    expectIssue(result.issues, 'q-icon.vue', { ruleId: 'button-name', tab: 'manual', source: '<QBtn icon="menu"' })
    expectIssue(result.issues, 'q-blank.vue', { ruleId: 'button-name', tab: 'manual' })
    expectIssue(result.issues, 'q-tooltip.vue', { ruleId: 'button-name', tab: 'ambiguous', reason: 'opaque-content' })
    expectIssue(result.issues, 'q-href.vue', { ruleId: 'link-name', tab: 'manual' })
    expectIssue(result.issues, 'q-anchor.vue', { ruleId: 'button-name', tab: 'manual' })
    expectIssue(result.issues, 'u-icon.vue', { ruleId: 'button-name', tab: 'manual', source: '<UButton' })
    expectIssue(result.issues, 'u-empty-label.vue', { ruleId: 'button-name', tab: 'manual' })
    expectIssue(result.issues, 'u-slot.vue', { ruleId: 'button-name', tab: 'ambiguous', reason: 'opaque-content' })
    expectIssue(result.issues, 'u-link.vue', { ruleId: 'link-name', tab: 'manual' })
    expectIssue(result.issues, 'dynamic-label.vue', { ruleId: 'button-name', tab: 'ambiguous', reason: 'dynamic-attribute' })
    expectIssue(result.issues, 'dynamic-aria.vue', { ruleId: 'button-name', tab: 'ambiguous', reason: 'dynamic-attribute' })
    expectIssue(result.issues, 'expression.vue', { ruleId: 'button-name', tab: 'ambiguous', reason: 'dynamic-content' })
    expectIssue(result.issues, 'slot-child.vue', { ruleId: 'button-name', tab: 'ambiguous', reason: 'opaque-content' })
    expectIssue(result.issues, 'html.vue', { ruleId: 'button-name', tab: 'ambiguous', reason: 'opaque-content' })
    expectIssue(result.issues, 'bare.vue', { ruleId: 'button-name', tab: 'ambiguous', reason: 'bare-bind' })
    expectIssue(result.issues, 'repeat.vue', { ruleId: 'button-name', tab: 'ambiguous', reason: 'repeated-source' })
    expectIssue(result.issues, 'root-button.vue', { ruleId: 'button-name', tab: 'ambiguous', reason: 'fallthrough' })
    expectIssue(result.issues, 'native.vue', { ruleId: 'image-alt', tab: 'manual', source: '<img' })
    expectIssue(result.issues, 'native.vue', { ruleId: 'button-name', tab: 'ambiguous', reason: 'opaque-content', source: '<button' })
    expectIssue(result.issues, 'native.vue', { ruleId: 'button-name', tab: 'manual', source: '<VBtn' })
    expectIssue(result.issues, 'q-tab.vue', { ruleId: 'tabindex', tab: 'quick', source: 'tabindex="3"' })
    expectIssue(result.issues, 'v-tab.vue', { ruleId: 'tabindex', tab: 'quick' })

    for (const name of [
      'text-prop.vue',
      'boolean-text.vue',
      'slot-text.vue',
      'aria.vue',
      'title.vue',
      'empty-alt.vue',
      'named-image.vue',
      'q-label.vue',
      'q-zero.vue',
      'q-labelled-tooltip.vue',
      'q-image.vue',
      'q-image-alt.vue',
      'u-label.vue',
      'u-leading.vue',
      'v-image-tab.vue',
    ]) {
      assert.equal(result.issues.some((issue) => issue.file && path.basename(issue.file) === name), false, name)
    }
    assert.equal(result.issues.some((issue) => issue.file && path.basename(issue.file) === 'u-tab.vue' && issue.ruleId === 'tabindex'), false)
    assert.equal(result.issues.some((issue) => issue.file && path.basename(issue.file) === 'unknown.vue' && (issue.sourceText ?? '').includes('SomeWidget')), false)
    assert.equal(result.issues.filter((issue) => issue.file && path.basename(issue.file) === 'unknown.vue').length, 1)

    for (const issue of result.issues) {
      assert.equal(issue.edits.some((edit) => /alt=|aria-label/.test(edit.insert)), false)
      if (issue.tab !== 'quick') assert.deepEqual(issue.edits, [])
      if (issue.sourceText) assert.equal(issue.sourceText.startsWith('<'), true)
    }

    const manual = result.issues.find((issue) => issue.file && path.basename(issue.file) === 'icon-button.vue')
    assert.equal(manual?.help, 'Кнопки должны иметь различимый текст')
    assert.equal(manual?.impact, 'critical')
    assert.equal(manual?.edits.length, 0)

    const tabindex = result.issues.find((issue) => issue.file && path.basename(issue.file) === 'q-tab.vue' && issue.ruleId === 'tabindex')
    assert.ok(tabindex)
    assert.equal(tabindex.edits[0]?.insert, '0')
    const file = tabindex.file ?? ''
    const applied = planApply({
      workspaceRoot: project.root,
      projectRoot: project.root,
      snapshots: result.files,
      current: { [file]: result.files[file] ?? '' },
      edits: tabindex.edits,
    })
    assert.equal(applied.ok, true)
    if (!applied.ok) return
    assert.match(applied.files[file]?.next ?? '', /tabindex="0"/)
    assert.doesNotMatch(applied.files[file]?.next ?? '', /aria-label|alt=/)
  } finally {
    project.cleanup()
  }
})

test('library components stay unknown without a verified install, import, or unshadowed registration', () => {
  const plain = createVueProject({
    'App.vue': sfc('', '<main><VBtn icon="mdi-menu" /><QBtn icon="menu" /><UButton icon="i-lucide-search" /><VImg src="/a.png" /><QImg src="/a.png" /></main>'),
  })
  const stale = createVueProject({
    'App.vue': sfc(vuetify, '<main><VBtn icon="mdi-menu" /><VImg src="/a.png" /></main>'),
  }, { vuetify: '4.3.3' })
  const shadowed = createVueProject({
    'vite.config.ts': 'import vuetify from \'vite-plugin-vuetify\'\nexport default { plugins: [vuetify()] }\n',
    'components/VBtn.vue': '<template><button>Local</button></template>\n',
    'App.vue': sfc('', '<main><VBtn icon="mdi-menu" /></main>'),
  }, versions)
  const disabled = createVueProject({
    'vite.config.ts': 'import vuetify from \'vite-plugin-vuetify\'\nexport default { plugins: [vuetify({ autoImport: false })] }\n',
    'App.vue': sfc('', '<main><VBtn icon="mdi-menu" /></main>'),
  }, versions)
  const localImport = createVueProject({
    'App.vue': sfc(`import VBtn from './VBtn.vue'\n`, '<main><VBtn icon="mdi-menu" /></main>'),
    'VBtn.vue': '<template><button></button></template>\n',
  }, versions)
  try {
    for (const fixture of [plain, stale, shadowed, disabled, localImport]) {
      const result = analyzeVueFiles(fixture.root, [path.join(fixture.root, 'App.vue')])
      assert.equal(result.issues.length, 0, fixture.root)
    }
  } finally {
    plain.cleanup()
    stale.cleanup()
    shadowed.cleanup()
    disabled.cleanup()
    localImport.cleanup()
  }
})

test('auto-registered library components are recognized when nothing local shadows them', () => {
  const project = createVueProject({
    'vite.config.ts': [
      'import vuetify from \'vite-plugin-vuetify\'',
      'import { quasar } from \'@quasar/vite-plugin\'',
      'import ui from \'@nuxt/ui/vite\'',
      'export default { plugins: [vuetify(), quasar(), ui()] }',
    ].join('\n'),
    'nuxt.config.ts': 'export default { modules: [\'@nuxt/ui\'] }\n',
    'VuetifyButton.vue': sfc('', '<main><VBtn icon="mdi-menu" /></main>'),
    'QuasarButton.vue': sfc('', '<main><q-btn icon="menu" /></main>'),
    'QuasarPascal.vue': sfc('', '<main><QBtn icon="menu" /></main>'),
    'NuxtButton.vue': sfc('', '<main><UButton icon="i-lucide-search" /></main>'),
  }, versions)
  const explicit = createVueProject({
    'components/VBtn.vue': '<template><button>Local</button></template>\n',
    'App.vue': sfc(vuetify, '<main><VBtn icon="mdi-menu" /></main>'),
  }, versions)
  try {
    const result = analyzeVueFiles(project.root, [
      path.join(project.root, 'VuetifyButton.vue'),
      path.join(project.root, 'QuasarButton.vue'),
      path.join(project.root, 'QuasarPascal.vue'),
      path.join(project.root, 'NuxtButton.vue'),
    ])
    expectIssue(result.issues, 'VuetifyButton.vue', { ruleId: 'button-name', tab: 'manual' })
    expectIssue(result.issues, 'QuasarButton.vue', { ruleId: 'button-name', tab: 'manual', source: '<q-btn' })
    expectIssue(result.issues, 'NuxtButton.vue', { ruleId: 'button-name', tab: 'manual' })
    assert.equal(result.issues.some((issue) => issue.file && path.basename(issue.file) === 'QuasarPascal.vue'), false)

    const imported = analyzeVueFiles(explicit.root, [path.join(explicit.root, 'App.vue')])
    expectIssue(imported.issues, 'App.vue', { ruleId: 'button-name', tab: 'manual', source: '<VBtn' })
  } finally {
    project.cleanup()
    explicit.cleanup()
  }
})

test('a broken Vue file does not stop library analysis of the next file', () => {
  const project = createVueProject({
    'broken.vue': '<template><VBtn></template>\n',
    'ok.vue': sfc(vuetify, '<main><VBtn icon="mdi-menu" /></main>'),
  }, versions)
  try {
    const result = analyzeVueFiles(project.root, [
      path.join(project.root, 'broken.vue'),
      path.join(project.root, 'ok.vue'),
    ])
    assert.equal(result.errors.length, 1)
    assert.equal(result.issues.length, 1)
    assert.equal(result.issues[0]?.ruleId, 'button-name')
    assert.equal(result.issues[0]?.file && path.basename(result.issues[0].file) === 'ok.vue', true)
  } finally {
    project.cleanup()
  }
})

function sfc(script: string, template: string): string {
  const block = script.trim() ? `<script setup>\n${script}</script>\n` : ''
  return `${block}<template>\n${template}\n</template>\n`
}

function expectIssue(
  issues: Issue[],
  fileName: string,
  expected: { ruleId: string; tab: Issue['tab']; reason?: string; source?: string },
): void {
  const found = issues.find((issue) => (
    issue.file && path.basename(issue.file) === fileName
    && issue.ruleId === expected.ruleId
    && issue.tab === expected.tab
    && (expected.reason === undefined || issue.reason === expected.reason)
    && (expected.source === undefined || (issue.sourceText ?? '').includes(expected.source))
  ))
  assert.ok(found, `${fileName} ${expected.tab} ${expected.ruleId} ${expected.reason ?? ''}`)
  assert.equal(found.edits.length > 0, expected.tab === 'quick')
}
