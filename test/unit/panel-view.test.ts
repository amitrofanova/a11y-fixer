import assert from 'node:assert/strict'
import test from 'node:test'
import { strings, type Language } from '../../src/i18n'
import { loadPanel, type PanelControl, type PanelPage } from '../support/panelPage'

interface ViewIssue {
  id: string
  ruleId: string
  impact: string
  impactLabel: string
  help: string
  description: string
  failureSummary: string
  helpUrl: string
  tab: 'quick' | 'manual' | 'ambiguous'
  file: string
  line: number
  source: string
  dom: string
  before: string
  after: string
  reason: string
  canReveal: boolean
  canFix: boolean
}

test('an idle panel names the check state in the VS Code language and does not list results', () => {
  const russian = show('ru', { status: 'idle', started: false })
  assert.equal(russian.lang(), 'ru')
  assert.equal(russian.status(), 'Проверка не запускалась')
  assert.match(russian.text(), /Выберите папку для проверки/)
  assert.equal(russian.buttons().some((button) => button.expanded !== undefined), false)

  const english = show('en', { status: 'idle', started: false })
  assert.equal(english.lang(), 'en')
  assert.equal(english.status(), 'No check has been run')
  assert.match(english.text(), /Choose a folder to check/)
  assert.doesNotMatch(english.text(), /WCAG conformance verdict/)
})

test('a running check keeps its status visible and refuses fixes', () => {
  const page = show('ru', {
    status: 'running',
    issues: [quick('tabindex'), quick('region')],
  })
  assert.equal(page.status(), 'Идёт проверка…')
  const fix = button(page, 'Исправить')
  const fixAll = button(page, 'Исправить все')
  assert.equal(fix.disabled, true)
  assert.equal(fixAll.disabled, true)
  fix.click()
  assert.equal(postedOf(page).length, 0)
  assert.equal(button(page, 'Показать в коде').disabled, false)
})

test('the selected quick fix shows the diff and confirmation sends only that issue', () => {
  const page = show('ru', { issues: [quick('tabindex'), quick('region'), manual(), ambiguous()] })
  assert.match(page.text(), /Положительный tabindex ломает порядок/)
  assert.doesNotMatch(page.text(), /Прокручиваемая область должна получать фокус/)
  assert.match(page.text(), /Было/)
  assert.match(page.text(), /<button tabindex="3">/)
  assert.match(page.text(), /Код с исправлением/)
  assert.match(page.text(), /<button tabindex="0">/)
  assert.doesNotMatch(page.text(), /Исходный код/)
  assert.match(page.text(), /Результат этой проверки не является заключением о соответствии WCAG/)
  assert.equal(page.buttons().filter((item) => item.text === 'Исправить').length, 1)

  button(page, 'Исправить').click()
  assert.deepEqual(postedOf(page).at(-1), { type: 'fix', id: 'tabindex' })
  button(page, 'Описание правила').click()
  assert.deepEqual(postedOf(page).at(-1), { type: 'open', url: 'https://example.test/tabindex' })
})

test('choosing another result replaces the open detail and keeps that choice after a refresh', () => {
  const issues = [quick('tabindex'), quick('region')]
  const page = show('ru', { issues })
  row(page, 'scrollable-region-focusable').click()
  assert.match(page.text(), /Прокручиваемая область должна получать фокус/)
  assert.doesNotMatch(page.text(), /Положительный tabindex ломает порядок/)
  assert.match(page.text(), /<div class="log" tabindex="0">/)
  assert.doesNotMatch(page.text(), /<button tabindex="0">/)

  page.post(message('ru', { issues }))
  assert.match(page.text(), /Прокручиваемая область должна получать фокус/)
  assert.doesNotMatch(page.text(), /Положительный tabindex ломает порядок/)

  page.post(message('ru', { issues: [quick('tabindex')] }))
  assert.match(page.text(), /Положительный tabindex ломает порядок/)
})

test('manual and ambiguous details stay explanatory and have no fix button', () => {
  const page = show('ru', { issues: [manual(), ambiguous()] })
  row(page, 'Ручные правки').click()
  assert.match(page.text(), /Исходный код/)
  assert.match(page.text(), /<img src="photo.png">/)
  assert.doesNotMatch(page.text(), /Было/)
  assert.equal(page.buttons().some((item) => item.text === 'Исправить'), false)
  button(page, 'Показать в коде').click()
  assert.deepEqual(postedOf(page).at(-1), { type: 'reveal', id: 'image-alt' })

  row(page, 'Неоднозначные').click()
  assert.match(page.text(), /Элемент находится внутри v-for/)
  assert.match(page.text(), /Фрагмент DOM/)
  assert.match(page.text(), /<button><\/button>/)
  assert.doesNotMatch(page.text(), /Исходный код/)
  assert.equal(page.buttons().some((item) => item.text === 'Исправить'), false)
  assert.equal(page.buttons().some((item) => item.text === 'Исправить все'), false)
})

test('a finished check with no issues still withholds a WCAG verdict in both languages', () => {
  const russian = show('ru', { status: 'ready', issues: [] })
  assert.equal(russian.status(), 'Проверка завершена')
  assert.match(russian.text(), /Однозначных правок нет/)
  assert.match(russian.text(), /не является заключением о соответствии WCAG/)

  const english = show('en', { status: 'ready', issues: [] })
  assert.equal(english.status(), 'Check finished')
  assert.match(english.text(), /No unambiguous fixes/)
  assert.match(english.text(), /not a WCAG conformance verdict/)
})

test('a stopped check shows the error and the results that were already on screen', () => {
  const page = show('ru', {
    status: 'error',
    message: 'Не найден Chrome или Chromium. Установите браузер или укажите путь в переменной CHROME_PATH.',
    issues: [quick('tabindex')],
  })
  assert.equal(page.status(), 'Проверка остановилась')
  assert.match(page.text(), /Не найден Chrome или Chromium/)
  assert.match(page.text(), /<button tabindex="3">/)
})

test('issues outside the scope and issues without a file stay out of the fix list', () => {
  const posted: unknown[] = []
  const page = loadPanel(posted)
  page.post(message('ru', {
    issues: [quick('tabindex')],
    outOfScope: [{
      id: 'meta',
      ruleId: 'meta-viewport',
      help: 'Масштаб запрещён',
      file: 'index.html',
      line: 5,
      canReveal: true,
    }],
    unmapped: [{
      ruleId: 'color-contrast',
      help: 'Контраст',
      dom: '<span style="color:gray">текст</span>',
    }],
  }))
  assert.match(page.text(), /Вне области/)
  assert.match(page.text(), /meta-viewport · index.html:5/)
  assert.match(page.text(), /Без файла/)
  assert.match(page.text(), /color-contrast/)
  assert.equal(page.buttons().filter((item) => item.text === 'Исправить').length, 1)
  const reveal = page.buttonsIn('meta-viewport').find((item) => item.text === 'Показать в коде')
  assert.ok(reveal)
  reveal?.click()
  assert.deepEqual(posted.at(-1), { type: 'reveal', id: 'meta' })
})

const pages = new WeakMap<PanelPage, unknown[]>()

function show(language: Language, patch: Record<string, unknown>): PanelPage {
  const posted: unknown[] = []
  const page = loadPanel(posted)
  pages.set(page, posted)
  page.post(message(language, patch))
  return page
}

function postedOf(page: PanelPage): unknown[] {
  const posted = pages.get(page)
  if (!posted) throw new Error('missing panel messages')
  return posted
}

function message(language: Language, patch: Record<string, unknown>): Record<string, unknown> {
  return {
    status: 'ready',
    message: '',
    ui: strings(language),
    language,
    started: true,
    scopeKind: 'folder',
    scopePath: 'src',
    outOfScope: [],
    unmapped: [],
    issues: [],
    ...patch,
  }
}

function button(page: PanelPage, label: string): PanelControl {
  const found = page.buttons().find((item) => item.text === label)
  assert.ok(found, label)
  if (!found) throw new Error(label)
  return found
}

function row(page: PanelPage, label: string): PanelControl {
  const found = page.buttons().find((item) => item.expanded !== undefined && item.text.includes(label))
    ?? page.buttons().find((item) => item.text.includes(label))
  assert.ok(found, label)
  if (!found) throw new Error(label)
  return found
}

function quick(kind: 'tabindex' | 'region'): ViewIssue {
  if (kind === 'tabindex') {
    return issue({
      id: 'tabindex',
      ruleId: 'tabindex',
      impactLabel: 'серьёзно',
      help: 'Значение tabindex больше нуля',
      description: 'Положительный tabindex ломает порядок.',
      file: 'src/App.vue',
      line: 4,
      source: '<button tabindex="3">',
      dom: '<button tabindex="3"></button>',
      before: '<button tabindex="3">',
      after: '<button tabindex="0">',
      helpUrl: 'https://example.test/tabindex',
      canFix: true,
    })
  }
  return issue({
    id: 'region',
    ruleId: 'scrollable-region-focusable',
    impact: 'moderate',
    impactLabel: 'умеренно',
    help: 'Область прокрутки не в фокусе',
    description: 'Прокручиваемая область должна получать фокус.',
    file: 'src/Log.vue',
    line: 8,
    source: '<div class="log">',
    dom: '<div class="log"></div>',
    before: '<div class="log">',
    after: '<div class="log" tabindex="0">',
    helpUrl: 'https://example.test/region',
    canFix: true,
  })
}

function manual(): ViewIssue {
  return issue({
    id: 'image-alt',
    ruleId: 'image-alt',
    tab: 'manual',
    help: 'У изображения нет alt',
    description: 'Текст alt выбирает человек.',
    file: 'src/Photo.vue',
    line: 2,
    source: '<img src="photo.png">',
    dom: '<img src="photo.png">',
    helpUrl: 'https://example.test/image-alt',
  })
}

function ambiguous(): ViewIssue {
  return issue({
    id: 'loop',
    ruleId: 'button-name',
    tab: 'ambiguous',
    help: 'У кнопки нет имени',
    description: 'Имя кнопки внутри цикла неочевидно.',
    reason: 'Элемент находится внутри v-for',
    dom: '<button></button>',
  })
}

function issue(patch: Partial<ViewIssue>): ViewIssue {
  return {
    id: 'issue',
    ruleId: 'rule',
    impact: 'serious',
    impactLabel: 'серьёзно',
    help: '',
    description: '',
    failureSummary: '',
    helpUrl: '',
    tab: 'quick',
    file: '',
    line: 0,
    source: '',
    dom: '',
    before: '',
    after: '',
    reason: '',
    canReveal: true,
    canFix: false,
    ...patch,
  }
}
