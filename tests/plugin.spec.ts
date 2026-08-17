import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolResult } from '@deepseek-ai/dsh-tools'
import * as zhihuPlugin from '../src/index.ts'
import {
  formatSearchOutput,
  parseSearchArgs,
  presentSearchCall,
  presentSearchResult,
  searchMetaFromResult,
  searchMetaFromValue,
} from '../src/search.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const testToolSignal = new AbortController().signal

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

function toolResult(meta: unknown, text = 'body', isError = false): ToolResult {
  const content: ContentBlock[] = [{ type: 'text', text }]
  return { content, isError, ...meta !== undefined ? { meta: meta as never } : {} }
}

async function mountTool(config: zhihuPlugin.Config = { apiKey: 'zhihu-secret' }) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = await ctx.plugin(zhihuPlugin, config)
  let counter = 0
  const call = (args: unknown) => ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${++counter}`),
    name: 'zhihu_search',
    arguments: args,
  })
  return { ctx, fiber, call }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('search formatting', () => {
  it('renders sources with titles, snippets, dates, and a citation reminder', () => {
    const out = formatSearchOutput({
      truncated: false,
      sources: [
        { url: 'https://www.zhihu.com/a', title: 'A', snippet: 'about a', publishedAt: '2026-01-01' },
        { url: 'https://www.zhihu.com/b' },
      ],
    })
    expect(out).toContain('[A](https://www.zhihu.com/a) — about a (2026-01-01)')
    expect(out).toContain('[www.zhihu.com](https://www.zhihu.com/b)')
    expect(out).toContain('Cite the relevant URLs')
  })

  it('reports no results when there are no sources', () => {
    expect(formatSearchOutput({ sources: [], truncated: false })).toContain('No results found.')
  })

  it('notes truncation', () => {
    const out = formatSearchOutput({ sources: [{ url: 'https://a.test' }], truncated: true })
    expect(out).toContain('Showing the first 1 sources')
  })

  it('validates the query', () => {
    expect(() => parseSearchArgs({ query: '   ' })).toThrow('non-empty')
    expect(parseSearchArgs({ query: 'hi' })).toEqual({ query: 'hi' })
  })

  it('presents a search call as a search-kind card titled by the query', () => {
    expect(presentSearchCall({ query: 'find me' })).toEqual({
      card: 'generic',
      title: 'find me',
      kind: 'search',
      rawInput: 'find me',
    })
  })

  it('projects sources into presentation meta', () => {
    expect(searchMetaFromValue({
      truncated: true,
      sources: [{ url: 'https://a.test', title: 'A' }],
    })).toEqual({
      truncated: true,
      sources: [{ url: 'https://a.test', title: 'A' }],
    })
  })

  it('derives a web/search result view from meta', () => {
    const view = presentSearchResult({ query: 'q' }, toolResult({
      truncated: false,
      sources: [{ url: 'https://a.test', title: 'A' }],
    }))
    expect(view).toEqual({
      card: 'web',
      kind: 'search',
      title: 'q',
      truncated: false,
      sources: [{ url: 'https://a.test', title: 'A' }],
    })
  })

  it('falls back when result meta is missing or the call failed', () => {
    expect(presentSearchResult({ query: 'q' }, toolResult(undefined))).toBeUndefined()
    expect(presentSearchResult({ query: 'q' }, toolResult({ sources: [], truncated: false }, 'err', true))).toBeUndefined()
    expect(searchMetaFromResult(undefined)).toBeUndefined()
  })
})

describe('zhihu_search plugin registration', () => {
  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in zhihuPlugin).toBe(false)
    expect(zhihuPlugin.name).toBe('tool-zhihu-search')
    expect(zhihuPlugin.inject).toEqual(['tools', 'systemPrompt'])
  })

  it('registers zhihu_search into ctx.tools (HMR-safe) and does not register web_search', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ Code: 0, Data: { Items: [] } })))
    const { ctx, fiber } = await mountTool()
    const names = ctx.tools.schemas().map(s => s.name)
    expect(names).toContain('zhihu_search')
    expect(names).not.toContain('web_search')
    await fiber.dispose()
    expect(ctx.tools.schemas().map(s => s.name)).not.toContain('zhihu_search')
  })

  it('contributes a prompt section that distinguishes zhihu_search from web_search', async () => {
    const { ctx, fiber } = await mountTool()
    const prompt = await ctx.systemPrompt.assemble()
    const text = prompt.sections.map(s => s.text).join('\n')
    expect(text).toContain('Use the zhihu_search tool to search Zhihu')
    expect(text).toContain('use web_search for the open web')
    await fiber.dispose()
  })

  it('executes zhihu_search and formats the result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      Code: 0,
      Data: {
        Items: [{ Url: 'https://www.zhihu.com/answer/1', Title: 'A', ContentText: 'snip' }],
      },
    })))
    const { fiber, call } = await mountTool()
    const out = await call({ query: 'rave 文化' })
    expect(out.isError).toBe(false)
    expect(out.value).toEqual({
      truncated: false,
      sources: [{ url: 'https://www.zhihu.com/answer/1', title: 'A', snippet: 'snip' }],
    })
    expect(out.content.map(b => b.type === 'text' ? b.text : '').join(''))
      .toContain('[A](https://www.zhihu.com/answer/1)')
    await fiber.dispose()
  })

  it('rejects a blank query', async () => {
    const { fiber, call } = await mountTool()
    const out = await call({ query: '   ' })
    expect(out.isError).toBe(true)
    await fiber.dispose()
  })

  it('keeps the tool visible when credentials are missing and fails at execution', async () => {
    const prev = process.env.ZHIHU_ACCESS_SECRET
    delete process.env.ZHIHU_ACCESS_SECRET
    try {
      const { ctx, fiber, call } = await mountTool({})
      expect(ctx.tools.schemas().map(s => s.name)).toContain('zhihu_search')
      const out = await call({ query: 'q' })
      expect(out.isError).toBe(true)
      expect(out.content.map(b => b.type === 'text' ? b.text : '').join(''))
        .toContain('ZHIHU_ACCESS_SECRET')
      await fiber.dispose()
    } finally {
      if (prev !== undefined) process.env.ZHIHU_ACCESS_SECRET = prev
    }
  })

  it('falls back to $ZHIHU_ACCESS_SECRET when config omits apiKey', async () => {
    const prev = process.env.ZHIHU_ACCESS_SECRET
    process.env.ZHIHU_ACCESS_SECRET = 'env-secret'
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ Code: 0, Data: { Items: [] } }))
      vi.stubGlobal('fetch', fetchMock)
      const { fiber, call } = await mountTool({})
      await call({ query: 'q' })
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string | URL, RequestInit]
      expect(String(url)).toContain('https://developer.zhihu.com/api/v1/content/zhihu_search')
      expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer env-secret')
      await fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.ZHIHU_ACCESS_SECRET
      else process.env.ZHIHU_ACCESS_SECRET = prev
    }
  })

  it('resolves ZHIHU_ACCESS_SECRET from ctx.credentials', async () => {
    const prev = process.env.ZHIHU_ACCESS_SECRET
    delete process.env.ZHIHU_ACCESS_SECRET
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ Code: 0, Data: { Items: [] } }))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      class FileCredentials extends Service {
        constructor(c: Context) {
          super(c, 'credentials')
        }
        resolve(ref: string) {
          if (ref !== 'ZHIHU_ACCESS_SECRET') return Promise.resolve(undefined)
          return Promise.resolve({ value: 'from-credentials-yaml', source: 'file' })
        }
      }
      await ctx.plugin(FileCredentials)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      const fiber = await ctx.plugin(zhihuPlugin, {})
      await ctx.tools.execute({
        signal: testToolSignal,
        callId: CallId('cred'),
        name: 'zhihu_search',
        arguments: { query: 'q' },
      })
      const [, init] = fetchMock.mock.calls[0] as unknown as [string | URL, RequestInit]
      expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer from-credentials-yaml')
      await fiber.dispose()
    } finally {
      if (prev !== undefined) process.env.ZHIHU_ACCESS_SECRET = prev
    }
  })

  it('sends the configured searchMaxResults as Count', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ Code: 0, Data: { Items: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    const { fiber, call } = await mountTool({ apiKey: 'zhihu-secret', searchMaxResults: 3 })
    await call({ query: 'q' })
    const [url] = fetchMock.mock.calls[0] as unknown as [string | URL]
    expect(new URL(String(url)).searchParams.get('Count')).toBe('3')
    await fiber.dispose()
  })
})

describe('bundle patch', () => {
  it('inserts the tool row and does not pin web.searchProvider', () => {
    const patch = readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain("name: '@wangshaodan/web-search-zhihu-insite'")
    expect(patch).toContain('id: tool-zhihu-search')
    expect(patch).toContain('apiKeyEnv: ZHIHU_ACCESS_SECRET')
    expect(patch).not.toMatch(/^\s*searchProvider:/m)
  })
})
