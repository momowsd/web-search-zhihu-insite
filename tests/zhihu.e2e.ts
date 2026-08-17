import { describe, expect, it } from 'vitest'
import {
  ZhihuSearchClient,
  ZHIHU_DEFAULT_BASE_URL,
  ZHIHU_DEFAULT_TIMEOUT_MS,
} from '../src/client.ts'

/**
 * Real-API smoke for the Zhihu in-site search client. Self-skips without
 * `$ZHIHU_ACCESS_SECRET`.
 */
const apiKey = process.env.ZHIHU_ACCESS_SECRET
const maybe = apiKey !== undefined && apiKey.length > 0 ? describe : describe.skip

maybe('ZhihuSearchClient real API', () => {
  it('returns sources for a live query', async () => {
    const client = new ZhihuSearchClient({
      apiKey: apiKey!,
      baseURL: process.env.ZHIHU_OPENAPI_BASE_URL ?? ZHIHU_DEFAULT_BASE_URL,
      ...process.env.ZHIHU_ZHIHU_SEARCH_URL !== undefined && process.env.ZHIHU_ZHIHU_SEARCH_URL.length > 0
        ? { endpoint: process.env.ZHIHU_ZHIHU_SEARCH_URL }
        : {},
      timeoutMs: ZHIHU_DEFAULT_TIMEOUT_MS,
    })
    const result = await client.search('DeepSeek Harness', 5)
    expect(result.sources.length).toBeGreaterThan(0)
    for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//)
  }, 30_000)
})
