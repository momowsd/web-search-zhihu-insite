# @wangshaodan/web-search-zhihu-insite

知乎站内搜索的 DeepSeek Harness **工具**插件。安装后向模型注册 `zhihu_search`，调用知乎 OpenAPI `zhihu_search`，返回知乎站内问答/文章。

本包**不是** `WebSearchProvider`，也**不会**覆盖 `web.config.searchProvider`。因此可以和 [`@wangshaodan/web-search-zhihu`](https://github.com/momowsd/web-search-zhihu) 同时安装：

| 工具 | 包 | 用途 |
|---|---|---|
| `web_search` | `@wangshaodan/web-search-zhihu`（或其它 search provider）+ `@deepseek-ai/dsh-tool-web` | 全网搜索 |
| `zhihu_search` | 本包 | 知乎站内搜索 |

0.2.0 相对 0.1.0 是破坏性变更：0.1.0 把站内搜索注册成 `web_search` 的后端，会和全网搜索抢同一个工具。升级后请重新 `dsh plugin add`，并确认 profile 里不再把 `searchProvider` 指到 `zhihu-insite-search`。

## 安装

`dsh plugin` 会把命令转发给 profile 目录里的 pnpm，因此本机 PATH 上需要有 `pnpm`。

```sh
dsh plugin --profile web add @wangshaodan/web-search-zhihu-insite
```

若还要全网搜索，同时安装：

```sh
dsh plugin --profile web add @wangshaodan/web-search-zhihu
```

本地开发 / 未发布时，也可把仓库目录或 tarball 交给 `dsh plugin`：

```sh
dsh plugin --profile web add /path/to/web-search-zhihu-insite
```

安装成功后，profile 会把本包加入 `dsh.profile.bundles`，并应用 [`cordis.patch.yml`](cordis.patch.yml)：插入插件行 `tool-zhihu-search`。它**不会**改 `web.config.searchProvider`。

用下面命令确认（输出中应出现 `# == @wangshaodan/web-search-zhihu-insite`，且工具列表含 `zhihu_search`；若同时装了全网插件，`searchProvider` 仍应是 `zhihu-global-search`）：

```sh
dsh --profile web --dump-config
```

从 0.1.x 升级时，如果 dump 里还看得到 `searchProvider: zhihu-insite-search`，在 profile / home 的 `cordis.patch.yml` 里改回全网 provider，或删掉那一行覆盖。

## 凭据配置

`ZHIHU_ACCESS_SECRET` 有两种配置方式，任选其一即可，可与全网搜索插件共用同一密钥。进程环境优先于 `$DSH_HOME/.credentials.yaml`。

**方式一：export 环境变量**

```sh
export ZHIHU_ACCESS_SECRET=你的密钥
dsh --profile web
```

**方式二：写入 `$DSH_HOME/.credentials.yaml`**

默认路径是 `~/.dsh/.credentials.yaml`（若设置了 `$DSH_HOME` 则用那个目录）。文件权限建议 `600`：

```yaml
ZHIHU_ACCESS_SECRET: 你的密钥
```

不要把密钥写进 `cordis.patch.yml` 或 git 仓库。

| 变量 | 必填 | 默认 | 含义 |
|---|---|---|---|
| `ZHIHU_ACCESS_SECRET` | 是 | — | Bearer Token。未设置时工具仍会出现在模型目录里，调用会失败 |
| `ZHIHU_OPENAPI_BASE_URL` | 否 | `https://developer.zhihu.com` | OpenAPI 源站，拼接 `/api/v1/content/zhihu_search` |
| `ZHIHU_ZHIHU_SEARCH_URL` | 否 | — | 完整 endpoint，优先级最高 |

## Config

| 键 | 默认 | 含义 |
|---|---|---|
| `apiKey` | （不设） | 字面量密钥。一般不用，优先用上面两种凭据方式 |
| `apiKeyEnv` | `ZHIHU_ACCESS_SECRET` | 凭据引用名 |
| `baseURL` | `$ZHIHU_OPENAPI_BASE_URL` → 公开源站 | OpenAPI origin |
| `endpoint` | `$ZHIHU_ZHIHU_SEARCH_URL` | 完整搜索 URL，覆盖 `baseURL` |
| `searchMaxResults` | `8` | 一次调用返回的来源数量上限，钳制到 1–10。**不**暴露给模型 |
| `searchTimeoutMs` | `30000` | 协作式工具超时（毫秒） |

```yaml
- id: tool-zhihu-search
  name: '@wangshaodan/web-search-zhihu-insite'
  config:
    apiKeyEnv: ZHIHU_ACCESS_SECRET
    searchMaxResults: 8
```

## 映射与错误

请求：`GET {endpoint}?Query=&Count=`。Header 含 `Authorization: Bearer …` 与 `X-Request-Timestamp`（秒级 Unix 时间戳）。HTTP 重定向会被拒绝。

每条结果映射为来源：

- `url` ← `Url`（无 URL 的条目丢弃）
- `title` ← `Title`
- `snippet` ← `ContentText`（去掉 `<em>` 高亮标签）
- `publishedAt` ← `EditTime`（秒级时间戳 → ISO-8601）

模型参数只有 `query`。失败时工具返回错误结果（密钥缺失、HTTP / 网络 / 非 JSON / `Code != 0` / 超时 / 取消），工具本身仍保持可见。

## 开发

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
npm pack --dry-run
```

真实 API 冒烟测试仅在设置了 `ZHIHU_ACCESS_SECRET` 时运行：

```sh
ZHIHU_ACCESS_SECRET=... pnpm test
```

发布前先 `pnpm build`（`prepack` 会自动执行）。

## 安全注意

- 把 `ZHIHU_ACCESS_SECRET` 放在进程环境或 `$DSH_HOME/.credentials.yaml`，不要提交到仓库或 patch 文件。`.credentials.yaml` 权限保持 `600`。
- `$ZHIHU_ZHIHU_SEARCH_URL` 被篡改时，Bearer token 可能发往非预期主机。
