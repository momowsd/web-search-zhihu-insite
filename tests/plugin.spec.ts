import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as zhihuPlugin from '../src/index.ts'
import { ZHIHU_PROVIDER_ID } from '../src/provider.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('web-search-zhihu-insite plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ Code: 0, Data: { Items: [] } })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: ZHIHU_PROVIDER_ID })
    const fiber = await ctx.plugin(zhihuPlugin, { apiKey: 'zhihu-secret' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in zhihuPlugin).toBe(false)
    expect(zhihuPlugin.name).toBe('web-search-zhihu-insite')
    expect(zhihuPlugin.inject).toEqual(['web'])
  })

  it('threads numResults config into the request and omits Filter/SearchDB', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ Code: 0, Data: { Items: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: ZHIHU_PROVIDER_ID })
    const fiber = await ctx.plugin(zhihuPlugin, {
      apiKey: 'zhihu-secret',
      numResults: 9,
    })
    await ctx.web.search({ query: 'q' })
    const [url] = fetchMock.mock.calls[0] as unknown as [string | URL]
    const parsed = new URL(String(url))
    expect(parsed.searchParams.get('Count')).toBe('9')
    expect(parsed.searchParams.has('Filter')).toBe(false)
    expect(parsed.searchParams.has('SearchDB')).toBe(false)
    await fiber.dispose()
  })

  it('falls back to $ZHIHU_ACCESS_SECRET and the default base URL when config omits them', async () => {
    const prev = process.env.ZHIHU_ACCESS_SECRET
    process.env.ZHIHU_ACCESS_SECRET = 'env-secret'
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ Code: 0, Data: { Items: [] } }))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: ZHIHU_PROVIDER_ID })
      const fiber = await ctx.plugin(zhihuPlugin, {})
      await ctx.web.search({ query: 'q' })
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string | URL, RequestInit]
      expect(String(url)).toContain('https://developer.zhihu.com/api/v1/content/zhihu_search')
      expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer env-secret')
      await fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.ZHIHU_ACCESS_SECRET
      else process.env.ZHIHU_ACCESS_SECRET = prev
    }
  })

  it('uses $ZHIHU_ZHIHU_SEARCH_URL as a full endpoint override', async () => {
    const prevSecret = process.env.ZHIHU_ACCESS_SECRET
    const prevEndpoint = process.env.ZHIHU_ZHIHU_SEARCH_URL
    process.env.ZHIHU_ACCESS_SECRET = 'env-secret'
    process.env.ZHIHU_ZHIHU_SEARCH_URL = 'https://gateway.test/zhihu_search'
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ Code: 0, Data: { Items: [] } }))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: ZHIHU_PROVIDER_ID })
      const fiber = await ctx.plugin(zhihuPlugin, {})
      await ctx.web.search({ query: 'q' })
      const [url] = fetchMock.mock.calls[0] as unknown as [string | URL]
      expect(new URL(String(url)).origin + new URL(String(url)).pathname)
        .toBe('https://gateway.test/zhihu_search')
      await fiber.dispose()
    } finally {
      if (prevSecret === undefined) delete process.env.ZHIHU_ACCESS_SECRET
      else process.env.ZHIHU_ACCESS_SECRET = prevSecret
      if (prevEndpoint === undefined) delete process.env.ZHIHU_ZHIHU_SEARCH_URL
      else process.env.ZHIHU_ZHIHU_SEARCH_URL = prevEndpoint
    }
  })

  it('resolves ZHIHU_ACCESS_SECRET from ctx.credentials (the .credentials.yaml plane)', async () => {
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
      await ctx.plugin(WebRuntime, { searchProvider: ZHIHU_PROVIDER_ID })
      const fiber = await ctx.plugin(zhihuPlugin, {})
      await ctx.web.search({ query: 'q' })
      const [, init] = fetchMock.mock.calls[0] as unknown as [string | URL, RequestInit]
      expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer from-credentials-yaml')
      await fiber.dispose()
    } finally {
      if (prev !== undefined) process.env.ZHIHU_ACCESS_SECRET = prev
    }
  })

  it('fails the search when neither config, env, nor credentials supplies a key', async () => {
    const prev = process.env.ZHIHU_ACCESS_SECRET
    delete process.env.ZHIHU_ACCESS_SECRET
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: ZHIHU_PROVIDER_ID })
      await ctx.plugin(zhihuPlugin, {})
      await expect(ctx.web.search({ query: 'q' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))
    } finally {
      if (prev !== undefined) process.env.ZHIHU_ACCESS_SECRET = prev
    }
  })
})

describe('bundle patch', () => {
  it('pins searchProvider to zhihu-insite-search and declares the plugin row', () => {
    const patch = readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('searchProvider: zhihu-insite-search')
    expect(patch).toContain("name: '@wangshaodan/web-search-zhihu-insite'")
    expect(patch).toContain('apiKeyEnv: ZHIHU_ACCESS_SECRET')
  })
})
