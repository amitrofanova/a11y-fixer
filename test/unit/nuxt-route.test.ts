import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { candidatePaths, planPageRoute, scanProjectLinks } from '../../src/core/nuxtRoute'

test('Nuxt page files become routes and components stay out of routing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-routes-'))
  try {
    const about = planPageRoute(root, path.join(root, 'pages', 'about.vue'))
    assert.equal(about?.dynamic, false)
    assert.equal(about?.staticPath, '/about')

    const nested = planPageRoute(root, path.join(root, 'pages', 'blog', 'index.vue'))
    assert.equal(nested?.staticPath, '/blog')

    const grouped = planPageRoute(root, path.join(root, 'app', 'pages', '(site)', 'pricing.vue'))
    assert.equal(grouped?.staticPath, '/pricing')

    const dotted = planPageRoute(root, path.join(root, 'pages', 'users.edit.vue'))
    assert.equal(dotted?.staticPath, '/users/edit')

    const user = planPageRoute(root, path.join(root, 'pages', 'users', '[id].vue'))
    assert.equal(user?.dynamic, true)
    assert.equal(user?.parentPath, '/users')
    assert.equal(user?.staticPath, null)
    assert.equal(user?.matches('/users/42'), true)
    assert.equal(user?.matches('/users'), false)
    assert.equal(user?.matches('/users/42/edit'), false)

    const post = planPageRoute(root, path.join(root, 'pages', 'users', '[id]', 'posts', '[post].vue'))
    assert.equal(post?.matches('/users/7/posts/3'), true)
    assert.equal(post?.parentPath, '/users')

    const docs = planPageRoute(root, path.join(root, 'pages', 'docs', '[...slug].vue'))
    assert.equal(docs?.matches('/docs/a/b'), true)
    assert.equal(docs?.matches('/docs'), false)

    const optional = planPageRoute(root, path.join(root, 'pages', '[[id]].vue'))
    assert.equal(optional?.matches('/'), true)
    assert.equal(optional?.matches('/abc'), true)

    assert.ok(user)
    if (!user) return
    const links = candidatePaths(
      ['/users/42', 'https://example.com/users/9', '/about', '/users/42/'],
      'http://127.0.0.1:3000/users',
      'http://127.0.0.1:3000/',
      user,
    )
    assert.deepEqual(links, ['/users/42'])

    const file = path.join(root, 'pages', 'Profile.vue')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '<template><p><NuxtLink to="/users/15">Профиль</NuxtLink></p></template>\n')
    assert.ok(scanProjectLinks(root, user).includes('/users/15'))
    assert.equal(planPageRoute(root, path.join(root, 'components', 'Button.vue')), null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
