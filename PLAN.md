# PLAN — dsh-plugin-chrome-driverless

目标：让 DSH 里的 Agent 用上一个**真实的、有头的、带登录态**的浏览器，而不用把浏览器逻辑塞进 DSH 自己。

底座：[`friddle/chrome-driverless`](https://github.com/friddle/chrome-driverless)（Playwright + Xvfb 持久化 Chrome，`POST /mcp` 控制接口，镜像由 GHCR CI 发布）。本仓库只做「接入层」，不改底座。

## 结论先行

| 决策 | 选择 | 理由 |
|---|---|---|
| D0 | 独立仓库 `friddle/dsh-plugin-chrome-driverless`，repo 根即 npm 包根 | 与 `dsh-plugin-piko-remote` 同一套发布方式 |
| D1 | **不走** `dsh-mcp-client` | 底座的 `/mcp` 是自有 JSON 信封，不是合规 MCP（无 `initialize`/`tools/list`）；走它会把服务动词压平 |
| D2 | 每个动词一个工具，不做 `browser(action, …)` 聚合 | 参数进 schema，模型按训练分布读得懂；聚合工具等于让它猜枚举 |
| D3 | 截图走 DSH 附件服务成 **image block** | 有头浏览器的价值就是视觉；base64 塞文本既费 token 又用不上视觉能力 |
| D4 | 容器生命周期**可选**（`manageContainer`），默认只连服务 | 有人已经在用 compose/k8s 管这个容器，插件不该抢方向盘 |
| D5 | `stopOnDispose` 默认 `false` | 数据卷里是真实登录态，容器应该活过 DSH 重启 |
| D6 | 端口**只绑 127.0.0.1** | 控制接口自己没有鉴权，暴露等于把登录态浏览器送人 |
| D7 | 测试全离线（注入 `fetch` / `spawn`） | 单测不该拉镜像、起 Docker |

## 阶段

### Phase 0 — 调研（✅）

- 现有 DSH 插件生态里没有浏览器类插件（npm 搜索 `dsh-plugin`、GitHub 账号下仓库均确认）；DSH 自带的是 `dsh-tool-web`（search/fetch，无浏览器）与 `dsh-mcp-client`（能挂外部 MCP 浏览器）。
- 横向对比见 README「和别的 Docker 里的 Chrome 比」。

### Phase 1 — 骨架与配置（✅）

- [x] `package.json` + `dsh.bundle.patch` + `cordis.patch.yml`（插入 `chrome-driverless` 行）
- [x] `lib/config.js`：schema + `resolveConfig` 归一化（坏值回落，不让一个错端口把每个工具调用变成连接错误）

### Phase 2 — 控制面与截图（✅）

- [x] `lib/client.js`：`POST /mcp` 信封、错误码映射（`BrowserApiError`）、`/health` `/debug/status` `/debug/logs`、`waitForHealth`
- [x] `lib/images.js`：base64 → `attachments.saveImage` → JSON 安全的图片引用 + image block

### Phase 3 — 容器（✅）

- [x] `lib/docker.js`：`buildRunArgv`（卷 / profile / 代理 / 回环端口）、`inspect`、`ensure`（建/起/等健康）、`stop`/`restart`/`logs`、`dispose`
- [x] `runOnce`：collect 模式收流 + 退出码 + 超时终止

### Phase 4 — 工具（✅）

- [x] 13 个工具：open / screenshot / elements / click / type / press / scroll / evaluate / tabs / profile / save_auth / status / container
- [x] 每类都能优雅降级：没有附件服务时不带图但仍有文本；截图被拒不影响导航成功

### Phase 5 — 测试与文档（✅）

- [x] `npm test`：38 个离线单测（配置 / 客户端 / 容器 / 工具）
- [x] README（安装、配置表、工具表、安全、横向对比、可选 MCP 路线）

### Phase 6 — 待办

- [ ] 真机联调：起容器 → 装插件 → 让 Agent 完成一次「打开站点 → 登录 → 截图确认」（需要一台能跑 Docker 的机器）
- [ ] `--caps` 类能力对齐：网络拦截（`browser_route`）、控制台/网络读取（复用 `/devtools` 反代）
- [ ] `pw/ai_task` 暴露成工具（服务端的自愈循环，长任务有用）
- [ ] GitHub Actions：打 tag 时 `npm publish` + 建 release
- [ ] 给 `chrome-driverless` 加合规 MCP 门面（见 README「可选路线」）
