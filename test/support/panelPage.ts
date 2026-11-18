import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { repoRootFrom } from './repo'

export interface PanelControl {
  text: string
  disabled: boolean
  expanded: string | undefined
  click(): void
}

export interface PanelPage {
  post(data: unknown): void
  text(): string
  buttons(): PanelControl[]
  buttonsIn(marker: string): PanelControl[]
  status(): string
  lang(): string
}

class PanelNode {
  readonly tagName: string
  className = ''
  children: PanelNode[] = []
  attrs: Record<string, string> = {}
  disabled = false
  type = ''
  parent: PanelNode | null = null
  private textValue: string | undefined
  private readonly listeners = new Map<string, Array<() => void>>()
  readonly classList: { add: (...names: string[]) => void }

  constructor(tagName: string) {
    this.tagName = tagName
    this.classList = {
      add: (...names: string[]) => {
        const current = new Set(this.className.split(/\s+/).filter(Boolean))
        for (const name of names) current.add(name)
        this.className = [...current].join(' ')
      },
    }
  }

  set textContent(value: string) {
    this.textValue = value
    this.children = []
  }

  get textContent(): string {
    if (this.children.length === 0) return this.textValue ?? ''
    return this.children.map((child) => child.textContent).join('')
  }

  set lang(value: string) {
    this.attrs.lang = value
  }

  get lang(): string {
    return this.attrs.lang ?? ''
  }

  append(...nodes: PanelNode[]): void {
    for (const node of nodes) {
      node.parent = this
      this.children.push(node)
    }
    if (nodes.length > 0) this.textValue = undefined
  }

  replaceChildren(...nodes: PanelNode[]): void {
    this.children = []
    this.textValue = undefined
    this.append(...nodes)
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value
  }

  getAttribute(name: string): string | undefined {
    return this.attrs[name]
  }

  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  click(): void {
    if (this.disabled) return
    for (const listener of this.listeners.get('click') ?? []) listener()
  }
}

export function loadPanel(posted: unknown[]): PanelPage {
  const app = new PanelNode('div')
  app.attrs.id = 'app'
  const documentElement = new PanelNode('html')
  const listeners: Array<(event: { data: unknown }) => void> = []
  const document = {
    documentElement,
    getElementById(id: string): PanelNode | null {
      return id === 'app' ? app : null
    },
    createElement(tag: string): PanelNode {
      return new PanelNode(tag)
    },
  }
  const context: vm.Context = {
    document,
    window: {
      addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
        if (type === 'message') listeners.push(listener)
      },
    },
    acquireVsCodeApi(): { postMessage(message: unknown): void } {
      return {
        postMessage(message: unknown) {
          posted.push(JSON.parse(JSON.stringify(message)) as unknown)
        },
      }
    },
  }
  vm.createContext(context)
  const source = fs.readFileSync(path.join(repoRootFrom(__dirname), 'media', 'panel.js'), 'utf8')
  vm.runInContext(source, context)
  return {
    post(data: unknown) {
      for (const listener of listeners) listener({ data })
    },
    text: () => app.textContent,
    buttons: () => collect(app).filter((node) => node.tagName === 'button').map((node) => ({
      text: node.textContent,
      disabled: node.disabled,
      expanded: node.getAttribute('aria-expanded'),
      click: () => node.click(),
    })),
    status: () => collect(app).find((node) => node.getAttribute('role') === 'status')?.textContent ?? '',
    lang: () => documentElement.lang,
    buttonsIn(marker: string) {
      const host = hostOf(app, marker)
      return (host ? collect(host) : []).filter((node) => node.tagName === 'button').map((node) => ({
        text: node.textContent,
        disabled: node.disabled,
        expanded: node.getAttribute('aria-expanded'),
        click: () => node.click(),
      }))
    },
  }
}

function collect(node: PanelNode): PanelNode[] {
  return [node, ...node.children.flatMap((child) => collect(child))]
}

function hostOf(node: PanelNode, marker: string): PanelNode | undefined {
  if (!node.textContent.includes(marker)) return undefined
  for (const child of node.children) {
    const found = hostOf(child, marker)
    if (found && collect(found).some((item) => item.tagName === 'button')) return found
  }
  return node
}
