# dsh-plugin-chrome-driverless

把 **Docker 里的有头 Chrome** 接进 DeepSeek Harness：Agent 能像人一样打开网页、看截图、点按输入、切 Tab、切 Profile，并把登录态持久化下来。

底座是 [`friddle/chrome-driverless`](https://github.com/friddle/chrome-driverless)——Playwright 驱动的持久化 Chrome（Xvfb 有头）+ 一套 MCP 风格的 HTTP 控制接口（`POST /mcp`）。本插件是这个服务在 DSH 里的那一层：

- **`lib/client.js`** —— 说服务的控制接口。它是 MCP *风格* 的 JSON 信封（`{method, params}` → `{result|error}`），没有 `initialize`/`tools/list`，所以**不走** `@deepseek-ai/dsh-mcp-client`：那个客户端说的是真 MCP。
- **`lib/docker.js`** —— 可选地由 DSH 管这个容器：建（挂上数据卷）、等 `/health`、按需停。也可以只连现成服务。
- **`lib/images.js`** —— 把服务返回的 base64 截图存进 DSH 附件服务，于是模型收到的是**真的图片块**，不是一坨 base64 文本。
- **`lib/tools.js`** —— 13 个工具：`browser_open` / `screenshot` / `elements` / `click` / `type` / `press` / `scroll` / `evaluate` / `tabs` / `profile` / `save_auth` / `status` / `container`。

## 为什么是插件而不是 MCP 客户端

服务自己的动词才是价值：多 Profile 隔离登录态、`save_auth` 导出、`pw/ai_task`、`/devtools/*` 调试反代。挂一个通用 MCP 桥会把这些压平成服务端碰巧发布的那几个方法，而且 `chrome-driverless` 目前也还不是合规 MCP server。要走 MCP，正确做法是给它加一层真 MCP 门面（见文末「可选路线」）。

## 安装

```bash
# GitHub 直装（不需要发 npm）
dsh plugin add github:friddle/dsh-plugin-chrome-driverless

# 或本地开发：repo 根就是包根
npm pack && dsh plugin add ./dsh-plugin-chrome-driverless-0.1.0.tgz
```

插件进 profile 后，`dsh.bundle.patch`（`cordis.patch.yml`）会插入一行 `chrome-driverless`：

```yaml
- insert:
    - id: chrome-driverless
      name: 'dsh-plugin-chrome-driverless'
```

要覆盖配置就在自己 profile 的 `cordis.patch.yml` 里按这个 id 打补丁：

```yaml
- id: chrome-driverless
  config:
    baseUrl: http://127.0.0.1:9223
    manageContainer: true
    dataDir: /srv/chrome-driverless
    profile: work
    proxy: http://10.0.0.2:7890
```

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:9223` | 服务地址；容器由本插件管时保持默认 |
| `manageContainer` | `false` | 由 DSH 启动/停止容器（需要 `docker` CLI） |
| `autoStart` | `true` | `manageContainer` 打开时，插件加载即确保容器在跑 |
| `stopOnDispose` | `false` | 插件卸载时停容器。**默认关**：登录态和数据卷应该活过 DSH 重启 |
| `containerName` | `chrome-driverless` | 容器名，已存在则复用 |
| `image` | `ghcr.io/friddle/chrome-driverless:latest` | 镜像，国内可换自建 |
| `port` | `9223` | 宿主端口，映射容器 9223；**只绑 127.0.0.1** |
| `dataDir` | `~/.dsh/chrome-driverless` | 持久化目录（profiles / auth.json / 浏览器 profile） |
| `profile` | `debug` | 容器启动时激活的 profile |
| `proxy` | 空 | 浏览器代理；留空直连，不写死任何地址 |
| `requestTimeoutMs` | `60000` | 控制接口超时 |
| `actionTimeoutMs` | `90000` | 导航/点击/输入这类动作超时 |
| `startupTimeoutMs` | `120000` | 等 `/health` 就绪的超时 |

## 工具

| 工具 | 干什么 |
|---|---|
| `browser_open` | 打开 URL，返回截图。共享浏览器，登录态跨调用保留 |
| `browser_screenshot` | 截当前 Tab，不改变页面 |
| `browser_elements` | 列出可交互元素的 selector / 坐标 / 文本——定位登录框最省 token |
| `browser_click` | 点：`selector` 优先，`text` 次之，`x`/`y` 兜底（覆盖层、hover 菜单、canvas） |
| `browser_type` | 输入，可先点 `selector` 或 `x`/`y`；`submit` 顺手回车 |
| `browser_press` | 单键：Enter / Escape / Tab / PageDown / 单字符 |
| `browser_scroll` | 滚轮（`dx`/`dy`），可先移到 `x`/`y` |
| `browser_evaluate` | 在页面里跑 JS 取结构化数据（页面上下文，不是 Node） |
| `browser_tabs` | list / new / select / close：其它工具都作用于当前 Tab |
| `browser_profile` | list / set：切换账号而不登出前一个（切换会重启 context） |
| `browser_save_auth` | 把当前 profile 的 cookies/localStorage 导出成 auth.json |
| `browser_status` | 服务是否可达 + 当前 URL/Profile + 容器状态；连不上时先查它 |
| `browser_container` | start / stop / restart / logs（仅在 `manageContainer` 打开时可用） |

## 安全

- 容器的 9223 **只绑回环**：这个控制接口自己没有鉴权，谁连上谁就能用你的登录态浏览器。
- 数据卷是宿主目录，装着真实登录态（cookie / localStorage）。别把 `dataDir` 放进会同步到云盘的目录。
- `proxy` 默认空：不预设任何代理，需要时用配置显式给。
- 插件不做任何网络暴露，也不改 DSH 自身文件。

## 和别的「Docker 里的 Chrome」比

| 方案 | 形态 | 有头/登录态 | 控制面 | DSH 接入 |
|---|---|---|---|---|
| **chrome-driverless**（本插件底座） | 自建镜像 + GHCR | 有头（Xvfb）+ 多 profile + auth.json 导出 | `POST /mcp`（自有动词）+ `/devtools/*` CDP 反代 + `/audio.mp3` | 本插件直连 |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | `npx` 或 HTTP | 有头可开；`--user-data-dir` 持久 profile；`--cdp-endpoint` 可连现成 Chrome | 真 MCP（a11y 快照为主，少截图） | `dsh-mcp-client`（stdio/streamable-http） |
| [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) | `npx` | 有头；可连现成 Chrome | 真 MCP + puppeteer；性能 trace / 网络 / 控制台 | `dsh-mcp-client` |
| [browserless](https://github.com/browserless/browserless) | Docker 商业授权 | 无头为主，多并发会话 | CDP + REST（`/content` `/screenshot` `/pdf` `/function`） | 需要自己包一层，或走它的 MCP |
| [Steel Browser](https://github.com/steel-dev/steel-browser) | Docker，Apache-2.0 | 无头为主，会话隔离 | CDP + REST，面向 agent 的沙箱 | 同上 |
| [browser-use](https://github.com/browser-use/browser-use) | Python + WebUI | 有头可配 | 自带 agent 循环，不是平台 | 当作另一个 agent，不是工具层 |
| Selenium Grid / neko / Kasm / BrowserBox | 各家 | 有头（VNC 看真人操作） | WebDriver / VNC | 需要 WebDriver 桥 |

结论：**要「真 MCP + 生态最大」就挂 Playwright MCP / chrome-devtools-mcp（DSH 有 `dsh-mcp-client`，连插件都不用写）**；要「我自己的有头、多 profile、登录态导出、音频/DevTools 都在一个服务里」就用本插件包 `chrome-driverless`。两者不冲突：`chrome-devtools-mcp --browser-url` 也能接到同一个容器的 CDP 上（走 `/devtools` 那条反代）。

## 可选路线：给 chrome-driverless 加真 MCP 门面

如果希望 DSH（以及 Claude Code / Cursor 等任何 MCP 客户端）不装插件也能用，最省事的是在 `chrome-driverless` 里加一个合规的 JSON-RPC `/mcp`：`initialize` / `tools/list` / `tools/call`，把现有 `_dispatch` 的 36 个方法映射成 tools。之后：

```yaml
- id: mcp-chrome
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    transport: streamable-http
    url: http://127.0.0.1:9223/mcp
```

两条路可以同时在（本插件给 DSH 原生工具与图片块，MCP 门面给别的客户端）。

## 开发

```bash
npm install
npm test          # 38 个单测：配置归一化 / 客户端错误映射 / 容器生命周期 / 工具输出
```

测试全离线：`fetch` 与 `spawn` 都是注入的，不需要 Docker、不需要浏览器。

## License

MIT
