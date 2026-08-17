import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ZhihuSearchClient,
  ZhihuSearchError,
  clampCount,
  editTimeToIso,
  mapZhihuItem,
  mapZhihuResponse,
  resolveSearchUrl,
  stripHighlightTags,
} from '../src/client.ts'

const options = {
  apiKey: 'zhihu-secret',
  baseURL: 'https://developer.zhihu.test',
  timeoutMs: 5_000,
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('helpers', () => {
  it('clamps Count to 1–10', () => {
    expect(clampCount(0)).toBe(1)
    expect(clampCount(8)).toBe(8)
    expect(clampCount(10)).toBe(10)
    expect(clampCount(20)).toBe(10)
    expect(clampCount(99)).toBe(10)
    expect(clampCount(1.9)).toBe(1)
    expect(clampCount(Number.NaN)).toBe(10)
  })

  it('strips Zhihu highlight tags', () => {
    expect(stripHighlightTags('hello <em>world</em>')).toBe('hello world')
    expect(stripHighlightTags('<EM>A</EM> and <em>B</em>')).toBe('A and B')
    expect(stripHighlightTags('  plain  ')).toBe('plain')
  })

  it('converts unix-seconds EditTime to ISO-8601', () => {
    expect(editTimeToIso(1745486539)).toBe('2025-04-24T09:22:19.000Z')
    expect(editTimeToIso(0)).toBeUndefined()
    expect(editTimeToIso(undefined)).toBeUndefined()
    expect(editTimeToIso(-1)).toBeUndefined()
  })

  it('resolves the search URL from endpoint or baseURL', () => {
    expect(resolveSearchUrl({ baseURL: 'https://developer.zhihu.com/' }))
      .toBe('https://developer.zhihu.com/api/v1/content/zhihu_search')
    expect(resolveSearchUrl({
      baseURL: 'https://developer.zhihu.com',
      endpoint: 'https://example.test/search',
    })).toBe('https://example.test/search')
  })
})

describe('Zhihu result mapping', () => {
  it('maps a full item', () => {
    expect(mapZhihuItem({
      Title: 'ChatGPT 会员',
      ContentText: '首先要澄清<em>误解</em>',
      Url: 'https://www.zhihu.com/answer/1',
      EditTime: 1745486539,
    })).toEqual({
      url: 'https://www.zhihu.com/answer/1',
      title: 'ChatGPT 会员',
      snippet: '首先要澄清误解',
      publishedAt: '2025-04-24T09:22:19.000Z',
    })
  })

  it('drops an item with no URL', () => {
    expect(mapZhihuItem({ Title: 'A', ContentText: 'hi' })).toBeUndefined()
    expect(mapZhihuItem({ Url: '  ' })).toBeUndefined()
  })

  it('omits empty optional fields rather than emitting them', () => {
    expect(mapZhihuItem({ Url: 'https://a.test', Title: '', ContentText: '  ', EditTime: null }))
      .toEqual({ url: 'https://a.test' })
  })

  it('maps a response and drops URL-less items', () => {
    const result = mapZhihuResponse({
      Code: 0,
      Data: {
        Items: [
          { Url: 'https://a.test', ContentText: 'one' },
          { Title: 'missing url' },
          { Url: 'https://c.test', Title: 'C', ContentText: '<em>three</em>' },
        ],
      },
    })
    expect(result).toEqual({
      sources: [
        { url: 'https://a.test', snippet: 'one' },
        { url: 'https://c.test', title: 'C', snippet: 'three' },
      ],
      truncated: false,
    })
  })

  it('tolerates a missing Items array', () => {
    expect(mapZhihuResponse({ Code: 0 }).sources).toEqual([])
    expect(mapZhihuResponse({ Code: 0, Data: {} }).sources).toEqual([])
  })
})

describe('ZhihuSearchClient request mapping', () => {
  it('sends Query, Count, Bearer auth and X-Request-Timestamp', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ Code: 0, Data: { Items: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    vi.setSystemTime(new Date('2026-08-17T10:00:00Z'))

    await new ZhihuSearchClient(options).search('rave 文化', 8)

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string | URL, RequestInit]
    const parsed = new URL(String(url))
    expect(parsed.origin + parsed.pathname).toBe('https://developer.zhihu.test/api/v1/content/zhihu_search')
    expect(parsed.searchParams.get('Query')).toBe('rave 文化')
    expect(parsed.searchParams.get('Count')).toBe('8')
    expect(parsed.searchParams.has('Filter')).toBe(false)
    expect(parsed.searchParams.has('SearchDB')).toBe(false)
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer zhihu-secret')
    expect((init.headers as Record<string, string>)['x-request-timestamp']).toBe('1786960800')
  })

  it('clamps Count to 10 when maxResults exceeds the API cap', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ Code: 0, Data: { Items: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    await new ZhihuSearchClient(options).search('q', 50)
    const [url] = fetchMock.mock.calls[0] as unknown as [string | URL]
    expect(new URL(String(url)).searchParams.get('Count')).toBe('10')
  })

  it('uses an explicit endpoint override', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ Code: 0, Data: { Items: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    await new ZhihuSearchClient({
      ...options,
      endpoint: 'https://gateway.test/zhihu_search',
    }).search('q', 5)
    const [url] = fetchMock.mock.calls[0] as unknown as [string | URL]
    expect(new URL(String(url)).origin + new URL(String(url)).pathname)
      .toBe('https://gateway.test/zhihu_search')
  })

  it('uses resolveApiKey when no literal apiKey is set', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ Code: 0, Data: { Items: [] } }))
    vi.stubGlobal('fetch', fetchMock)
    await new ZhihuSearchClient({
      ...options,
      apiKey: '',
      resolveApiKey: async () => 'from-credentials-yaml',
    }).search('q', 5)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string | URL, RequestInit]
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer from-credentials-yaml')
  })
})

describe('ZhihuSearchClient error handling', () => {
  it('maps a business Code != 0 to ZHIHU_SEARCH_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ Code: 401, Message: 'invalid secret' })))
    await expect(new ZhihuSearchClient(options).search('q', 5))
      .rejects.toThrow(expect.objectContaining({ code: 'ZHIHU_SEARCH_ERROR', message: 'invalid secret' }))
  })

  it('maps an HTTP error with the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ Message: 'bad key' }, { status: 401 })))
    await expect(new ZhihuSearchClient(options).search('q', 5))
      .rejects.toThrow(expect.objectContaining({ code: 'ZHIHU_SEARCH_ERROR', message: 'bad key' }))
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway down', { status: 502 })))
    await expect(new ZhihuSearchClient(options).search('q', 5))
      .rejects.toThrow(expect.objectContaining({ code: 'ZHIHU_SEARCH_ERROR', message: 'Zhihu API error (HTTP 502)' }))
  })

  it('maps a network failure to ZHIHU_SEARCH_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(new ZhihuSearchClient(options).search('q', 5))
      .rejects.toThrow(expect.objectContaining({ code: 'ZHIHU_SEARCH_ERROR' }))
  })

  it('maps an abort to ZHIHU_SEARCH_ABORTED', async () => {
    const controller = new AbortController()
    controller.abort()
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(new ZhihuSearchClient(options).search('q', 5, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'ZHIHU_SEARCH_ABORTED' }))
  })

  it('maps a timeout abort to ZHIHU_SEARCH_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(new ZhihuSearchClient(options).search('q', 5))
      .rejects.toThrow(expect.objectContaining({
        code: 'ZHIHU_SEARCH_ERROR',
        message: 'Zhihu search timed out after 5000ms',
      }))
  })

  it('maps a missing credential to ZHIHU_SEARCH_CREDENTIAL_MISSING', async () => {
    await expect(new ZhihuSearchClient({
      ...options,
      apiKey: '',
      resolveApiKey: async () => undefined,
    }).search('q', 5))
      .rejects.toBeInstanceOf(ZhihuSearchError)
    await expect(new ZhihuSearchClient({
      ...options,
      apiKey: '',
      resolveApiKey: async () => undefined,
    }).search('q', 5))
      .rejects.toThrow(expect.objectContaining({ code: 'ZHIHU_SEARCH_CREDENTIAL_MISSING' }))
  })
})
