import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { repoRootFrom } from '../support/repo'

const repoRoot = repoRootFrom(__dirname)
const suite = path.join(repoRoot, 'out-test', 'test', 'editor', 'suite.js')
const executable = process.env.A11Y_VSCODE ?? '/usr/share/code/code'
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-vscode-'))
const workspace = path.join(scratch, 'workspace')
const userData = path.join(scratch, 'user-data')
const extensionsDir = path.join(scratch, 'extensions')

fs.mkdirSync(workspace)
fs.mkdirSync(path.join(userData, 'User'), { recursive: true })
fs.mkdirSync(extensionsDir)
fs.writeFileSync(path.join(userData, 'User', 'settings.json'), `${JSON.stringify({
  'security.workspace.trust.enabled': false,
  'update.mode': 'none',
  'extensions.autoUpdate': false,
  'files.autoSave': 'off',
  'workbench.startupEditor': 'none',
  'window.restoreWindows': 'none',
}, null, 2)}\n`)

if (!fs.existsSync(executable)) {
  console.error(`VS Code executable not found: ${executable}`)
  process.exit(1)
}
if (!fs.existsSync(suite)) {
  console.error(`Editor suite is not compiled: ${suite}`)
  process.exit(1)
}

const args = [
  workspace,
  `--extensionDevelopmentPath=${repoRoot}`,
  `--extensionTestsPath=${suite}`,
  `--user-data-dir=${userData}`,
  `--extensions-dir=${extensionsDir}`,
  '--disable-extensions',
  '--disable-workspace-trust',
  '--disable-updates',
  '--disable-crash-reporter',
  '--skip-welcome',
  '--skip-release-notes',
  '--disable-telemetry',
  '--disable-gpu',
]
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(executable, args, { stdio: 'inherit', env })
const timer = setTimeout(() => {
  console.error('VS Code editor test timed out')
  child.kill('SIGKILL')
}, 240000)

child.on('error', (error) => {
  clearTimeout(timer)
  fs.rmSync(scratch, { recursive: true, force: true })
  console.error(error)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  clearTimeout(timer)
  fs.rmSync(scratch, { recursive: true, force: true })
  if (signal) {
    console.error(`VS Code ended by ${signal}`)
    process.exit(1)
  }
  process.exit(code ?? 1)
})
