# @wangshaodan/web-search-zhihu-insite

知乎站内搜索（`zhihu_search`）的 DeepSeek Harness `WebSearchProvider` 插件。安装后向 `ctx.web` 注册 provider `zhihu-insite-search`，由 `@deepseek-ai/dsh-tool-web` 的 `web_search` 工具消费。本包**不**注册面向模型的 tool，也**不**占用 `ctx.web` 服务键。

这是知乎站内内容搜索，不是全网搜索。全网搜索请使用 [`@wangshaodan/web-search-zhihu`](https://github.com/momowsd/web-search-zhihu)（`global_search`）。两个插件可以同时安装，但 `web.config.searchProvider` 同时只能指向一个 provider；后安装的插件 patch 会覆盖默认选择。

## 安装

`dsh plugin` 会把命令转发给 profile 目录里的 pnpm，因此本机 PATH 上需要有 `pnpm`。

发布到 npm 后：

```sh
dsh plugin --profile web add @wangshaodan/web-search-zhihu-insite
```

从 GitHub 安装依赖（不经过 npm registry）：

```sh
npm install -g github:momowsd/web-search-zhihu-insite
# 或
npm install -g https://github.com/momowsd/web-search-zhihu-insite.git
```

clone 后在本地安装依赖：

```sh
git clone https://github.com/momowsd/web-search-zhihu-insite.git
cd web-search-zhihu-insite
npm install
npm run build
```

本地开发 / 未发布时，也可把仓库目录或 tarball 交给 `dsh plugin`：

```sh
dsh plugin --profile web add /path/to/web-search-zhihu-insite
# 或
pnpm pack
dsh plugin --profile web add ./wangshaodan-web-search-zhihu-insite-0.1.0.tgz
```

安装成功后，profile 会把本包加入 `dsh.profile.bundles`，并应用 [`cordis.patch.yml`](cordis.patch.yml)：

- 插入插件行 `web-search-zhihu-insite`
- 将 `web.config.searchProvider` 覆盖为 `zhihu-insite-search`

用下面命令确认层已生效（输出中应出现 `# == @wangshaodan/web-search-zhihu-insite`，且 `searchProvider` 为 `zhihu-insite-search`）：

```sh
dsh --profile web --dump-config
```

用户仍可通过 profile / home 的 `cordis.patch.yml`，或环境变量 `$DSH_WEB_SEARCH_PROVIDER` 覆盖所选 provider。

## 凭据配置

`ZHIHU_ACCESS_SECRET` 有两种配置方式，任选其一即可。进程环境优先于 `$DSH_HOME/.credentials.yaml`（与 DSH 其它凭据相同）。可与全网搜索插件共用同一密钥。

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

```sh
# 若文件尚不存在
install -m 600 /dev/null "${DSH_HOME:-$HOME/.dsh}/.credentials.yaml"
# 然后编辑上述文件，加入 ZHIHU_ACCESS_SECRET 一行
chmod 600 "${DSH_HOME:-$HOME/.dsh}/.credentials.yaml"
```

两种方式都不要把密钥写进 `cordis.patch.yml` 或 git 仓库。可选的 `ZHIHU_OPENAPI_BASE_URL` / `ZHIHU_ZHIHU_SEARCH_URL` 仍只走环境变量。

| 变量 | 必填 | 默认 | 含义 |
|---|---|---|---|
| `ZHIHU_ACCESS_SECRET` | 是 | — | Bearer Token。环境变量或 `.credentials.yaml` 都未设置时，搜索会以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败 |
| `ZHIHU_OPENAPI_BASE_URL` | 否 | `https://developer.zhihu.com` | OpenAPI 源站，拼接 `/api/v1/content/zhihu_search` |
| `ZHIHU_ZHIHU_SEARCH_URL` | 否 | — | 完整 endpoint，优先级最高 |

## Config

| 键 | 默认 | 含义 |
|---|---|---|
| `apiKey` | （不设） | 字面量密钥。一般不用，优先用下面两种凭据方式 |
| `apiKeyEnv` | `ZHIHU_ACCESS_SECRET` | 凭据引用名：每次搜索经 `ctx.credentials`（含 `$DSH_HOME/.credentials.yaml`）解析，没有凭据平面时再读环境变量 |
| `baseURL` | `$ZHIHU_OPENAPI_BASE_URL` → 公开源站 | OpenAPI origin |
| `endpoint` | `$ZHIHU_ZHIHU_SEARCH_URL` | 完整搜索 URL，覆盖 `baseURL` |
| `numResults` | `10` | 请求未带 `maxResults` 时的 `Count`，钳制到 1–10 |
| `timeoutMs` | `30000` | HTTP 超时（毫秒） |

站内搜索不支持全网搜索的 `filter` / `searchDB`。

```yaml
- id: web-search-zhihu-insite
  name: '@wangshaodan/web-search-zhihu-insite'
  config:
    apiKeyEnv: ZHIHU_ACCESS_SECRET
    numResults: 10
```

## 映射与错误

请求：`GET {endpoint}?Query=&Count=`。Header 含 `Authorization: Bearer …` 与 `X-Request-Timestamp`（秒级 Unix 时间戳）。HTTP 重定向会被拒绝。

每条结果映射为 `WebSearchSource`：

- `url` ← `Url`（无 URL 的条目丢弃）
- `title` ← `Title`
- `snippet` ← `ContentText`（去掉 `<em>` 高亮标签）
- `publishedAt` ← `EditTime`（秒级时间戳 → ISO-8601）

知乎不返回生成式答案，因此省略 `content`。`Count` 上限 10；seam 仍会按 `maxResults` 截断。

失败约定：

- HTTP / 网络 / 非 JSON / `Code != 0` / 超时 → `WebError` `WEB_PROVIDER_ERROR`
- 未配置 `ZHIHU_ACCESS_SECRET` → `WEB_PROVIDER_CREDENTIAL_MISSING`
- 调用方 `AbortSignal` 取消 → `WEB_ABORTED`

## 开发

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm pack --dry-run
```

真实 API 冒烟测试仅在设置了 `ZHIHU_ACCESS_SECRET` 时运行：

```sh
ZHIHU_ACCESS_SECRET=... pnpm test
```

发布前先 `pnpm build`（`prepack` 会自动执行）。npm 安装使用预构建的 `lib/`，不需要用户本机编译。从 git 源安装时，请改用 `pnpm pack` 后的 tarball，或自行允许 `prepare` 构建脚本。

## 安全注意

- 把 `ZHIHU_ACCESS_SECRET` 放在进程环境或 `$DSH_HOME/.credentials.yaml`，不要提交到仓库或 patch 文件。`.credentials.yaml` 权限保持 `600`。
- `$ZHIHU_ZHIHU_SEARCH_URL` 被篡改时，Bearer token 可能发往非预期主机。
