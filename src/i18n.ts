export type Language = 'ru' | 'en'

export function languageOf(locale: string): Language {
  return locale.toLowerCase().startsWith('ru') ? 'ru' : 'en'
}

const text = {
  ru: {
    audit: 'Проверить',
    pickScope: 'Выбрать файлы для проверки',
    pickDialog: 'Выберите папку или файл внутри проекта',
    auditing: 'Идёт проверка…',
    empty: 'Выберите папку для проверки или вызовите «Проверить доступность» в контекстном меню проводника. Приложение запустится из корня проекта, в результатах останутся только файлы выбранной области.',
    quick: 'Быстрые правки',
    manual: 'Ручные правки',
    ambiguous: 'Неоднозначные',
    quickEmpty: 'Однозначных правок нет.',
    manualEmpty: 'Нарушений для ручного исправления нет.',
    ambiguousEmpty: 'Неоднозначных нарушений нет.',
    fix: 'Исправить',
    fixAll: 'Исправить все',
    fixAllRerun: 'Исправить все и перезапустить проверку',
    report: 'Создать отчёт',
    reveal: 'Показать в коде',
    auditProject: 'Весь проект',
    scopeProject: 'Область: весь проект',
    scopeFolder: 'Область',
    outOfScopeTitle: 'Вне области',
    unmappedTitle: 'Без файла',
    notInFixes: 'Не входят в исправления.',
    noFolder: 'Выберите папку или файл внутри проекта Vue 3 + Vite или Nuxt.',
    outsideWorkspace: 'Файл лежит вне открытой папки. Запись отменена.',
    outsideScope: 'Правка выходит за выбранную область. Запись отменена.',
    source: 'Исходный код',
    dom: 'Фрагмент DOM',
    proposed: 'Код с исправлением',
    docs: 'Описание правила',
    reportNote: 'Отчёт включает все три вкладки.',
    noVite: 'В корне открытой папки нет vite.config или nuxt.config. Откройте проект Vue 3 + Vite или Nuxt.',
    noNuxt: 'В проекте есть nuxt.config, но пакет nuxt не установлен.',
    noRoute: 'Для этой страницы не нашлось рабочей ссылки. Динамический адрес не подбирается наугад, поэтому проверка не запускалась.',
    pageNotRendered: 'Страница открылась, но выбранный файл в ней не отрисовался. Результат к нему не относится.',
    noChrome: 'Не найден Chrome или Chromium. Установите браузер или укажите путь в переменной CHROME_PATH.',
    axeMissing: 'Проверка DOM не запустилась: axe-core не загрузился в страницу.',
    noPort: 'Локальный сервер не открыл порт на 127.0.0.1.',
    failed: 'Не удалось записать правку.',
    stale: 'Файл изменился после проверки. Повторите проверку, не записывая чужие правки поверх.',
    overlap: 'Правки в одном файле пересекаются. Исправьте их по одной и повторите проверку.',
    unsafe: 'Правка добавила бы доступное имя. Запись отменена.',
    savedReport: 'Отчёт записан',
    nothingToFix: 'Нет быстрых правок для записи',
    applied: 'Правки записаны',
    mappingOff: 'Точная привязка к Vue-файлам недоступна: у @vitejs/plugin-vue нет api.options. Быстрые правки в компонентах не предлагаются.',
    impact: {
      critical: 'критично',
      serious: 'серьёзно',
      moderate: 'умеренно',
      minor: 'незначительно',
    },
    reason: {
      unmapped: 'Не удалось найти место в исходнике',
      'multiple-instances': 'Один фрагмент исходника создаёт несколько элементов',
      'repeated-source': 'Элемент находится внутри v-for',
      'dynamic-attribute': 'Нужный атрибут задаётся динамически',
      'bare-bind': 'На элементе есть v-bind объекта, правка может задеть чужие атрибуты',
      'attribute-present': 'Атрибут уже задан',
      'no-insert-point': 'Не удалось безопасно найти конец открывающего тега',
      'no-attribute': 'В исходнике нет атрибута, который можно изменить',
      'unsafe-value': 'Значение атрибута нельзя безопасно записать',
      'unsupported-rule': 'Для этого правила нет однозначной автоматической правки',
      'not-one': 'В файле несколько подходящих тегов, выбор неоднозначен',
      stale: 'Файл уже изменён этой правкой. Координаты сняты до новой проверки',
      fallthrough: 'Атрибут может прийти от родительского компонента',
      'dynamic-content': 'Текст задаётся выражением, его значение из шаблона не видно',
      'opaque-content': 'Содержимое зависит от компонента, слота или v-html',
      'unresolved-label': 'aria-labelledby не указывает на статический текст в этом файле',
    },
  },
  en: {
    audit: 'Check',
    pickScope: 'Choose files to check',
    pickDialog: 'Choose a folder or file inside the project',
    auditing: 'Checking…',
    empty: 'Choose a folder to check, or use “Check accessibility” in the explorer context menu. The app still starts from the project root; results are limited to the selected scope.',
    quick: 'Quick fixes',
    manual: 'Manual fixes',
    ambiguous: 'Ambiguous',
    quickEmpty: 'No unambiguous fixes.',
    manualEmpty: 'No issues that need a manual edit.',
    ambiguousEmpty: 'No ambiguous issues.',
    fix: 'Fix',
    fixAll: 'Fix all',
    fixAllRerun: 'Fix all and check again',
    report: 'Create report',
    reveal: 'Show in code',
    auditProject: 'Whole project',
    scopeProject: 'Scope: whole project',
    scopeFolder: 'Scope',
    outOfScopeTitle: 'Outside scope',
    unmappedTitle: 'No source file',
    notInFixes: 'These are not included in fixes.',
    noFolder: 'Choose a folder or file inside the Vue 3 + Vite or Nuxt project.',
    outsideWorkspace: 'The file is outside the opened folder. The write was cancelled.',
    outsideScope: 'The edit is outside the selected scope. The write was cancelled.',
    source: 'Source',
    dom: 'DOM fragment',
    proposed: 'Proposed fix',
    docs: 'Rule description',
    reportNote: 'The report includes all three tabs.',
    noVite: 'The opened folder has neither vite.config nor nuxt.config. Open a Vue 3 + Vite or Nuxt project.',
    noNuxt: 'nuxt.config is present, but the nuxt package is not installed.',
    noRoute: 'No working link was found for this page. A dynamic address is not guessed, so the check did not start.',
    pageNotRendered: 'A page opened, but the selected file was not rendered. The result does not belong to it.',
    noChrome: 'Chrome or Chromium was not found. Install a browser or set CHROME_PATH.',
    axeMissing: 'The DOM check did not start: axe-core was not loaded into the page.',
    noPort: 'The local server did not open a port on 127.0.0.1.',
    failed: 'The fix could not be saved.',
    stale: 'The file changed after the check. Run the check again instead of writing over newer edits.',
    overlap: 'Edits in one file overlap. Apply them one at a time and check again.',
    unsafe: 'The edit would add an accessible name. The write was cancelled.',
    savedReport: 'Report saved',
    nothingToFix: 'There are no quick fixes to apply',
    applied: 'Fixes saved',
    mappingOff: 'Precise Vue mapping is unavailable: @vitejs/plugin-vue has no api.options. Quick fixes inside components are not offered.',
    impact: {
      critical: 'critical',
      serious: 'serious',
      moderate: 'moderate',
      minor: 'minor',
    },
    reason: {
      unmapped: 'The source location could not be found',
      'multiple-instances': 'One source fragment produces several elements',
      'repeated-source': 'The element is inside v-for',
      'dynamic-attribute': 'The attribute is dynamic',
      'bare-bind': 'A v-bind object may also set this attribute',
      'attribute-present': 'The attribute is already present',
      'no-insert-point': 'The end of the opening tag could not be found safely',
      'no-attribute': 'The source has no attribute that can be changed',
      'unsafe-value': 'The attribute value cannot be written safely',
      'unsupported-rule': 'This rule has no unambiguous automatic fix',
      'not-one': 'Several matching tags make the choice ambiguous',
      stale: 'This file was already changed by the fix. Ranges were dropped until the next check',
      fallthrough: 'A parent component may pass this attribute through',
      'dynamic-content': 'The text comes from an expression, so its value is not visible in the template',
      'opaque-content': 'The contents come from a component, slot, or v-html',
      'unresolved-label': 'aria-labelledby does not point at static text in this file',
    },
  },
} as const

export type Strings = (typeof text)[Language]

export function strings(language: Language): Strings {
  return text[language]
}

export function impactLabel(language: Language, impact: string | null): string {
  const labels = text[language].impact
  if (impact && impact in labels) return labels[impact as keyof typeof labels]
  return impact ?? '—'
}

export function reasonText(language: Language, reason: string | undefined): string {
  if (!reason) return ''
  const reasons = text[language].reason
  if (reason in reasons) return reasons[reason as keyof typeof reasons]
  return reason
}

export function messageText(language: Language, code: string): string {
  const table = text[language]
  if (code in table && typeof table[code as keyof Strings] === 'string') {
    return table[code as keyof Strings] as string
  }
  return code
}
