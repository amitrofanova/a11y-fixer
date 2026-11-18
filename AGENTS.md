# A11y Fixer

Локальное расширение VS Code: динамический аудит доступности Vue 3 + Vite и Nuxt, статический разбор Vue SFC, точное сопоставление с исходником и безопасный Quick Fix.

Перед изменениями прочитай:

- [.cursor/rules/a11y-fixer.mdc](.cursor/rules/a11y-fixer.mdc) — ограничения каждой сессии;
- [docs/architecture.md](docs/architecture.md) — контракты, запуск Vite/Nuxt и текущие границы;
- [docs/testing.md](docs/testing.md) — команды и состав тестов;
- [docs/mvp.md](docs/mvp.md) — контракт записи.

Работа идёт по согласованным этапам. Внутри этапа цикл такой: ожидаемое поведение, красный или характеризующий тест, минимальная реализация, рефакторинг без смены поведения, регрессия этапа. Следующий этап начинается только после подтверждения.

Быстрый цикл — `npm test`. Перед сдачей этапа — `npm run check`. Для продуктового Nuxt — `npm run test:nuxt`. Для Vuetify, Quasar и Nuxt UI — `npm run test:libraries`. Для записи через `WorkspaceEdit` в окне VS Code — `npm run test:editor`.
