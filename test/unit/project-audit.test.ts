import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { auditVisits, isStrictPage, mergeAudits, vueFilesForAudit } from '../../src/core/projectAudit'
import type { AuditOutcome, Issue } from '../../src/core/types'

test('a whole-project audit lists every Vue SFC outside excluded directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-vue-files-'))
  const profile = path.join(root, 'pages', 'profile.vue')
  const widget = path.join(root, 'components', 'Widget.vue')
  const layout = path.join(root, 'layouts', 'default.vue')
  const skipped = path.join(root, 'node_modules', 'Skip.vue')
  write(profile, '<template><button class="profile"></button></template>\n')
  write(widget, '<template><button class="widget"></button></template>\n')
  write(layout, '<template><button class="layout"></button></template>\n')
  write(skipped, '<template><button class="skip"></button></template>\n')
  write(path.join(root, 'notes.txt'), 'not a component')
  try {
    const whole = vueFilesForAudit(root, null).map((file) => path.relative(root, file)).sort()
    assert.deepEqual(whole, [
      path.join('components', 'Widget.vue'),
      path.join('layouts', 'default.vue'),
      path.join('pages', 'profile.vue'),
    ])
    assert.deepEqual(
      vueFilesForAudit(root, path.join(root, 'pages')).map((file) => path.relative(root, file)),
      [path.join('pages', 'profile.vue')],
    )
    assert.deepEqual(vueFilesForAudit(root, profile), [profile])
    assert.deepEqual(vueFilesForAudit(root, path.join(root, 'notes.txt')), [])
    const replaced = vueFilesForAudit(root, null, ['pages']).map((file) => path.relative(root, file)).sort()
    assert.deepEqual(replaced, [
      path.join('components', 'Widget.vue'),
      path.join('layouts', 'default.vue'),
      path.join('node_modules', 'Skip.vue'),
    ])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a Nuxt directory check visits every static page in scope and keeps dynamic pages for a later attempt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-pages-'))
  write(path.join(root, 'pages', 'index.vue'), '<template><main /></template>\n')
  write(path.join(root, 'pages', 'about.vue'), '<template><main /></template>\n')
  write(path.join(root, 'pages', 'blog', 'post.vue'), '<template><main /></template>\n')
  write(path.join(root, 'pages', 'users', '[id].vue'), '<template><main /></template>\n')
  write(path.join(root, 'components', 'Widget.vue'), '<template><button /></template>\n')
  write(path.join(root, 'node_modules', 'pages', 'secret.vue'), '<template><main /></template>\n')
  try {
    const whole = auditVisits(root, null, undefined, true)
    assert.deepEqual(whole.map(describeVisit), [
      { path: '/', file: path.join(root, 'pages', 'index.vue'), dynamic: false },
      { path: '/about', file: path.join(root, 'pages', 'about.vue'), dynamic: false },
      { path: '/blog/post', file: path.join(root, 'pages', 'blog', 'post.vue'), dynamic: false },
      { path: '/users', file: path.join(root, 'pages', 'users', '[id].vue'), dynamic: true },
    ])
    assert.equal(isStrictPage(null, whole), false)

    const blog = auditVisits(root, path.join(root, 'pages', 'blog'), undefined, true)
    assert.deepEqual(blog.map(describeVisit), [
      { path: '/blog/post', file: path.join(root, 'pages', 'blog', 'post.vue'), dynamic: false },
    ])

    const about = path.join(root, 'pages', 'about.vue')
    const one = auditVisits(root, about, undefined, true)
    assert.deepEqual(one.map(describeVisit), [
      { path: '/about', file: about, dynamic: false },
    ])
    assert.equal(isStrictPage(about, one), true)

    const component = auditVisits(root, path.join(root, 'components', 'Widget.vue'), undefined, true)
    assert.deepEqual(component.map(describeVisit), [{ path: '/', file: null, dynamic: false }])
    assert.equal(isStrictPage(path.join(root, 'components', 'Widget.vue'), component), false)

    const vite = auditVisits(root, null, undefined, false)
    assert.deepEqual(vite.map(describeVisit), [{ path: '/', file: null, dynamic: false }])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a project without an index page still opens the root before the other static pages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-pages-root-'))
  write(path.join(root, 'pages', 'about.vue'), '<template><main /></template>\n')
  try {
    const visits = auditVisits(root, null, undefined, true)
    assert.deepEqual(visits.map((visit) => visit.path), ['/', '/about'])
    assert.equal(visits[0]?.file, null)
    assert.equal(visits[1]?.file, path.join(root, 'pages', 'about.vue'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('static findings from an unopened Vue file stay, and a rendered node keeps one result', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-merge-'))
  const profile = path.join(root, 'pages', 'profile.vue')
  const home = path.join(root, 'pages', 'index.vue')
  const profileSource = '<template><button class="profile"></button></template>\n'
  const homeSource = '<template><button class="home"></button><img class="photo" src="/a.png" /></template>\n'
  write(profile, profileSource)
  write(home, homeSource)
  const homeMarker = `12:48:${encodeURIComponent(home)}`
  const dynamic = outcome({
    issues: [
      issue({
        id: 'dynamic-button',
        ruleId: 'button-name',
        tab: 'manual',
        help: 'from axe',
        file: home,
        start: 12,
        end: 48,
        domHtml: '<button class="home"></button>',
        sourceText: '<button class="home"></button>',
      }),
      issue({
        id: 'dynamic-loop',
        ruleId: 'button-name',
        tab: 'ambiguous',
        reason: 'multiple-instances',
        file: home,
        start: 60,
        end: 90,
        sourceText: '<button v-for="row in rows">',
      }),
      issue({
        id: 'route-a',
        ruleId: 'tabindex',
        tab: 'quick',
        file: home,
        start: 100,
        end: 130,
        edits: [{ file: home, start: 110, end: 111, insert: '0' }],
      }),
      issue({
        id: 'route-b',
        ruleId: 'tabindex',
        tab: 'quick',
        file: home,
        start: 100,
        end: 130,
        edits: [{ file: home, start: 110, end: 111, insert: '0' }],
      }),
      issue({ id: 'contrast', ruleId: 'color-contrast', tab: 'ambiguous', reason: 'unsupported-rule' }),
    ],
    files: { [home]: homeSource },
  })
  const merged = mergeAudits(dynamic, {
    issues: [
      issue({
        id: 'static-profile',
        ruleId: 'button-name',
        tab: 'manual',
        help: 'from source',
        file: profile,
        start: 10,
        end: 42,
        sourceText: '<button class="profile"></button>',
      }),
      issue({
        id: 'static-home',
        ruleId: 'button-name',
        tab: 'manual',
        help: 'from source',
        file: home,
        start: 12,
        end: 48,
        sourceText: '<button class="home"></button>',
      }),
      issue({
        id: 'static-loop',
        ruleId: 'button-name',
        tab: 'manual',
        help: 'from source',
        file: home,
        start: 60,
        end: 90,
      }),
      issue({
        id: 'static-photo',
        ruleId: 'image-alt',
        tab: 'manual',
        file: home,
        start: 49,
        end: 80,
        sourceText: '<img class="photo"',
      }),
      issue({
        id: 'static-tab',
        ruleId: 'tabindex',
        tab: 'quick',
        file: home,
        start: 100,
        end: 130,
        edits: [{ file: home, start: 110, end: 111, insert: '0' }],
      }),
    ],
    errors: [{ file: path.join(root, 'broken.vue'), message: 'PARSE_FAILED bad template' }],
    files: { [profile]: profileSource, [home]: 'stale home' },
  }, [homeMarker, `49:80:${encodeURIComponent(home)}`, `100:130:${encodeURIComponent(home)}`])
  try {
    const profileIssue = merged.issues.find((item) => item.file === profile)
    assert.equal(profileIssue?.ruleId, 'button-name')
    assert.equal(profileIssue?.origin, 'static')
    assert.equal(profileIssue?.tab, 'manual')

    const homeButton = merged.issues.find((item) => item.ruleId === 'button-name' && item.start === 12)
    assert.equal(homeButton?.origin, 'both')
    assert.equal(homeButton?.help, 'from axe')
    assert.equal(homeButton?.domHtml, '<button class="home"></button>')
    assert.equal(merged.issues.filter((item) => item.ruleId === 'button-name' && item.start === 12).length, 1)

    const loop = merged.issues.find((item) => item.start === 60)
    assert.equal(loop?.tab, 'ambiguous')
    assert.equal(loop?.origin, 'both')
    assert.deepEqual(loop?.edits, [])

    assert.equal(merged.issues.some((item) => item.ruleId === 'image-alt'), false)

    const tabindex = merged.issues.filter((item) => item.ruleId === 'tabindex')
    assert.equal(tabindex.length, 1)
    assert.equal(tabindex[0]?.tab, 'quick')
    assert.equal(tabindex[0]?.origin, 'both')

    assert.equal(merged.issues.find((item) => item.ruleId === 'color-contrast')?.origin, 'dynamic')
    assert.equal(merged.files[profile], profileSource)
    assert.equal(merged.files[home], homeSource)
    assert.deepEqual(merged.errors, [{ file: path.join(root, 'broken.vue'), message: 'PARSE_FAILED bad template' }])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function describeVisit(visit: { path: string; file: string | null; plan: { dynamic: boolean } | null }): { path: string; file: string | null; dynamic: boolean } {
  return { path: visit.path, file: visit.file, dynamic: visit.plan?.dynamic ?? false }
}

function write(file: string, source: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, source)
}

function outcome(patch: Pick<AuditOutcome, 'issues' | 'files'>): AuditOutcome {
  return {
    url: 'http://127.0.0.1:4173/',
    mappingEnabled: true,
    issues: patch.issues,
    files: patch.files,
  }
}

function issue(patch: Partial<Issue> & Pick<Issue, 'id' | 'ruleId' | 'tab'>): Issue {
  return {
    impact: 'serious',
    description: '',
    help: patch.ruleId,
    helpUrl: '',
    failureSummary: '',
    domHtml: '',
    edits: [],
    ...patch,
  }
}
