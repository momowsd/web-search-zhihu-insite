/**
 * `@wangshaodan/web-search-zhihu-insite`: registers a Zhihu in-site
 * `WebSearchProvider` with `ctx.web`. A function/namespace plugin (NOT a
 * default-export service): a search provider does not own the `ctx.web` key —
 * it registers INTO the seam's provider registry. The key is owned by
 * `@deepseek-ai/dsh-web`.
 *
 * @module @wangshaodan/web-search-zhihu-insite
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import {
  ZhihuSearchProvider,
  ZHIHU_DEFAULT_BASE_URL,
  ZHIHU_DEFAULT_NUM_RESULTS,
  ZHIHU_DEFAULT_TIMEOUT_MS,
} from './provider.ts'

export {
  ZHIHU_DEFAULT_BASE_URL,
  ZHIHU_DEFAULT_NUM_RESULTS,
  ZHIHU_DEFAULT_TIMEOUT_MS,
  ZHIHU_MAX_NUM_RESULTS,
  ZHIHU_PROVIDER_ID,
  ZHIHU_SEARCH_PATH,
  ZhihuSearchProvider,
  clampCount,
  editTimeToIso,
  mapZhihuItem,
  mapZhihuResponse,
  resolveSearchUrl,
  stripHighlightTags,
} from './provider.ts'
export type { ZhihuSearchProviderOptions } from './provider.ts'
export type { ZhihuSearchItem, ZhihuSearchResponse } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-zhihu-insite'

/** The web seam this provider registers into. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'ZHIHU_ACCESS_SECRET'
const BASE_URL_ENV = 'ZHIHU_OPENAPI_BASE_URL'
const ENDPOINT_ENV = 'ZHIHU_ZHIHU_SEARCH_URL'

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Literal Zhihu access secret; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey?: string
  /** Credential reference resolved per search (`ctx.credentials` / `$DSH_HOME/.credentials.yaml`, then the environment). Defaults to `ZHIHU_ACCESS_SECRET`. */
  apiKeyEnv?: string
  /** OpenAPI origin. Falls back to `$ZHIHU_OPENAPI_BASE_URL`, then the public origin. */
  baseURL?: string
  /** Full search URL. Falls back to `$ZHIHU_ZHIHU_SEARCH_URL`. Wins over `baseURL`. */
  endpoint?: string
  /** Default result count when a request carries no `maxResults`. Defaults to 10, clamped to 1–10. */
  numResults?: number
  /** HTTP timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  endpoint: z.string(),
  numResults: z.number().step(1).min(1).max(10).default(ZHIHU_DEFAULT_NUM_RESULTS),
  timeoutMs: z.number().step(1).min(1).default(ZHIHU_DEFAULT_TIMEOUT_MS),
})

/** Register the Zhihu in-site search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  const apiKeyEnv = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV
  const env = launchEnvironmentOf(ctx)
  const endpoint = nonEmpty(config.endpoint) ?? nonEmpty(env.get(ENDPOINT_ENV)?.value)
  const literalApiKey = nonEmpty(config.apiKey)
  ctx.web.registerSearchProvider(new ZhihuSearchProvider({
    ...literalApiKey !== undefined ? { apiKey: literalApiKey } : {},
    apiKeyEnv,
    resolveApiKey: () => resolveAccessSecret(ctx, apiKeyEnv),
    baseURL: config.baseURL ?? env.get(BASE_URL_ENV)?.value ?? ZHIHU_DEFAULT_BASE_URL,
    ...endpoint !== undefined ? { endpoint } : {},
    numResults: config.numResults ?? ZHIHU_DEFAULT_NUM_RESULTS,
    timeoutMs: config.timeoutMs ?? ZHIHU_DEFAULT_TIMEOUT_MS,
  }))
}

/**
 * Resolve `ZHIHU_ACCESS_SECRET` (or a renamed {@link Config.apiKeyEnv}) for one search.
 * When `ctx.credentials` is mounted (dsh-base does this), that seam already layers
 * process env over `$DSH_HOME/.credentials.yaml` and the launcher `.env` files.
 * Without the seam, fall back to the launch environment snapshot.
 */
async function resolveAccessSecret(ctx: Context, apiKeyEnv: string): Promise<string | undefined> {
  const credentials = ctx.get('credentials') as CredentialSeam | undefined
  if (credentials !== undefined) {
    return nonEmpty((await credentials.resolve(apiKeyEnv))?.value)
  }
  return nonEmpty(launchEnvironmentOf(ctx).get(apiKeyEnv)?.value)
}

interface CredentialSeam {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined
}
