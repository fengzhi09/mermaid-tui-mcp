# M001: v0.2.0 收口

**Gathered:** 2026-06-04
**Status:** Ready for planning

## Project Description

将 `mermaid-tui-mcp` 从 v0.1.0 单工具版收口为 v0.2.0:补齐测试 + CI、扩展 MCP 工具面(7 个)、建立可观测性、真实集成验证。保留所有现有能力,零回归。

## Why This Milestone

v0.1.0 已发布且有用户在使用(gsd-pi / Claude Code / opencode / Hermes / OpenClaw),但缺测试、缺 CI、缺可观测性、LLM 调不到 pin(eval 9 显式指出)、缺历史图查询能力(CRUD 不完整)。M001 在不破坏现有用户的前提下把这些洞补上,让 v0.2.0 成为下一个稳定可推荐版本。

## User-Visible Outcome

### When this milestone is complete, the user can:

- LLM 调 `render_mermaid({code, title?})` → 拿到 ASCII + fileLink + httpLink + title
- LLM 调 `pin_mermaid` / `unpin_mermaid` / `list_diagrams` / `get_diagram` / `delete_mermaid` / `search_diagrams` 完整 CRUD
- 7 天后未 pin 图自动 sweep,pin 图保留
- 5 客户端(gsd-pi / Claude Code / opencode / Hermes / OpenClaw)开箱即用
- `/health` 端点真实报告 counters + 5 条 last_errors + last_render_ms + 版本 + TTL

### Entry point / environment

- Entry point: `node src/server.mjs`(stdio MCP default; `MERMAID_RENDERER_HTTP=1` 启用 HTTP 伴侣)
- Environment: local dev, Node 22+;CI 在 Node 22 + 24 跑
- Live dependencies involved: 无(纯本地,无网络)

## Completion Class

- Contract complete means: 10 evals 全部跑通(真实 exec),覆盖率 ≥ 80%,所有 7 个 MCP 工具的 schema/响应/错误码契约有自动化测试
- Integration complete means: stdio MCP 真实 roundtrip 全 7 工具,`/health` 真实返 metrics(非 mock),Claude Code + gsd-pi 真集成冒烟通过
- Operational complete means: stderr JSON 日志在真实压力下产生、计数器持久化在重启后保留、port fallback 真实触发过、jsdom 重试真实触发过、10s 超时可注入测

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- Real end-to-end: agent spawn server → 初始化 → 调 `render_mermaid({code, title: "test"})` → 拿到 id → 调 `search_diagrams({query: "test"})` → 命中 → 调 `get_diagram({id})` → 拿到完整对象(含 title) → 调 `pin_mermaid({id})` → sweep 不删 → 调 `delete_mermaid({id})` → 真的删了
- Real end-to-end: Claude Code 启 MCP、gsd-pi 启 MCP,各调一次 `render_mermaid`,均返回 ASCII + 链接
- What cannot be simulated: 真集成的 setup 复杂度(尤其是 gsd-pi 的 mcp.json 注册 + Claude Code 的 .mcp.json)、npm install 在干净环境跑通、CI 在 GitHub Actions 上跑绿

## Architectural Decisions

### Test 框架选 vitest

**Decision:** 使用 vitest 作为 M001 测试框架。

**Rationale:** API 顺手、watch/UI 体验好、生态熟、社区推荐度高。覆盖 `node:test` 的能力(并行、覆盖率、mock)且更易用。代价 +1 dev dep,值得。

**Alternatives Considered:**
- `node:test` 内建 — 零 dep,Node 24 已成熟;但 API 较生硬,watch 体验差

### Storage 抽象用工厂 + 配置

**Decision:** 引入 `StorageBackend` interface + `LocalFsStorage` 默认实现,通过 `MERMAID_RENDERER_BACKEND=local|oss` env 切换。`OssStorage` 在 M002 接入。

**Rationale:** 为 M002 的云存储(OSS / 订阅)留干净的接入点,server.mjs 一行 import 切换。薄 interface(10 方法)开销低,行为契约清晰。

**Alternatives Considered:**
- 薄 interface(无工厂)— 同样可切换,但 server.mjs 改动多一行,部署侧无 env 控制
- plugin 自动发现 — 过度设计,本地单进程不需要

### Metrics 仅扩 /health

**Decision:** 仅扩展 `/health` 端点加 `counters` + `last_render_ms` + `last_errors`(5 条环形)。不开独立 `/metrics` Prometheus 端点。

**Rationale:** local-only 单用户场景,运维信号轻量;`/health` 已存在,扩一个端点 0 协议变更。Prometheus exposition 格式需 ~80 行手写或拉 dep,价值/成本不划算。

**Alternatives Considered:**
- 两个都要 — 可分两 slice 做,M001 一个就够

### 错误分类 chokepoint 用 zod

**Decision:** 使用 zod 4.x 做 JSON Schema 校验 + 错误分类的 chokepoint。

**Rationale:** TS-first 类型推断免费;业界标准;~50KB dep 合理;严格校验 + `retryable` 标志让 LLM 可编程响应。

**Alternatives Considered:**
- 手写 classify + schema — 0 dep,~80 行,但与"手写 JSON 日志"路线略不一致(此项目已决定加 dep)
- ajv — JSON Schema 标准,严格但 ~150KB 重

### 不上 MCP progress,改 `elapsed_ms` 字段

**Decision:** 不实现 MCP `notifications/progress` 协议;改为在所有 7 个工具的结果中加 `elapsed_ms` 字段(数字,毫秒)。

**Rationale:** 实际渲染 < 2s,加 progress 多一层客户端兼容;`elapsed_ms` 0 协议开销、0 IPC 成本、客户端不感知;真变慢(> 5s)再升 (c),是非 breaking 改动。

**Alternatives Considered:**
- 完整 MCP progress — 加 ~5-20ms 协议开销,buggy 客户端可能 hang

### 计数器持久化到 data/counters.json

**Decision:** 计数器(`render_total` / `render_errors` / `ascii_failures` / `storage_write_retries` / `sweep_runs` / `sweep_removed`)落到 `data/counters.json`,启动时 load,每次 increment 时 save(用 `tmp+rename` 原子写)。

**Rationale:** 重启后健康检查能反映历史趋势;`/health` 报告才有连续性;代价仅多写一次 FS。

**Alternatives Considered:**
- 内存 Map 重启清零 — 简单,但失去历史趋势

### Last errors 用 5 条环形缓冲

**Decision:** `/health` 返 `last_errors: [{code, at, retryable}, ...]`,环形缓冲保留最近 5 条。

**Rationale:** 调试足够(看最近几次错误码),响应体小(5 条);Agent/监控可在重启前抓最后一次错误状态。

**Alternatives Considered:**
- 1 条滚动 — 健康检查只看到最新,丢上下文
- 10 条环形 — 调试更有用,但 /health 响应体变大

### 覆盖门槛 80%

**Decision:** CI 强制行覆盖 ≥ 80%(通过 `vitest --coverage` + threshold 断言)。

**Rationale:** MCP 小代码基 80% 可达且合理;不追求 90% 避免仪式化测试(为覆盖而覆盖)。

**Alternatives Considered:**
- 90% — 严格但仪式重
- 不设门槛 — 减少仪式,但失去回归兜底

### CI Node 矩阵 22 + 24

**Decision:** GitHub Actions 在 Node 22 + 24 双版本跑(覆盖 `engines.node >= 22` 上下界)。

**Rationale:** 用户在 Node 22 LTS 与最新 24 之间;双版本矩阵覆盖主战场;Mermaid 11 + jsdom 25 在 20 上有未知兼容性,先不覆盖。

**Alternatives Considered:**
- 仅 Node 24 — `engines` 提到 24,简化 CI,但拒绝 Node 22 用户
- 20 + 22 + 24 — 最广,但 20 兼容性需额外验证

### S04 真实集成 smoke

**Decision:** S04 必须实际启 Claude Code 与 gsd-pi 调一次 MCP,确认端到端可用,不止 MCP Inspector 跑通。

**Rationale:** MCP Inspector 验证协议层;真实客户端验证集成层(配置加载、stdio 启动、超时、错误处理);`/docs/integration/*.md` 的指引在真实环境下验证。

**Alternatives Considered:**
- 仅 MCP Inspector — 失去集成层验证
- 全 5 客户端实跑 — OpenClaw 无原生 MCP,setup 重,M001 性价比低

### MCP 工具集:7 个

**Decision:** M001 暴露 7 个 MCP 工具:`render_mermaid`(Create)+ 6 个资源管理(pin/unpin/list/get/delete/search)。CRUD 完整闭环。

**Rationale:** 用户的对称性要求("支持添加就该支持删除、列表和查询")— CRUD 完整;`pin/unpin` 解决 eval 9 缺口;`search` 引入 title 锚点。

**Alternatives Considered:**
- 仅 5 个(render + pin + list + get)— 缺 delete + search,CRUD 不闭合

### render_mermaid 接受可选 title

**Decision:** `render_mermaid` 入参新增可选 `title: string`(≤200 字),存入 entry 元数据,view.html 显示,可被 `search_diagrams` 搜索到。

**Rationale:** 把搜索锚点从纯 `code` 提到 `title`,LLM 凭标题关键词就能找回旧图,体验更直接;可选避免破坏现有调用方。

**Alternatives Considered:**
- title 必填 — 强制 LLM 起标题,破坏现有调用方
- 不加 title — 搜索只能搜 code,体验差

### search_diagrams 覆盖 title + code

**Decision:** `search_diagrams({query, ...})` 对 `title` + `code` 都做大小写不敏感子串匹配,`titleMatch: true` 标记命中 title;同组内 `createdAt` 降序,title 命中优先于 code 命中。

**Rationale:** title 是用户友好锚点,code 是兜底;title 优先排序让 LLM 更快拿到"最可能想要"的结果。

**Alternatives Considered:**
- 仅搜 code — 失去 title 友好性
- 仅搜 title — code 是事实,搜不到等于看不见

### delete_mermaid 严格 404

**Decision:** `delete_mermaid({id})` id 不存在时返 `-32005 storage_read_failed`,不返回 `deleted: true` 假装成功。

**Rationale:** 强制 LLM 先 `list` 确认再删,避免误删;幂等是 LLM 自己的事(可 `list` 后再 `delete`)。

**Alternatives Considered:**
- 幂等(不存在也返 deleted: true)— 隐藏错误,LLM 不知道删失败

## Error Handling Strategy

- 输入校验:严格 JSON Schema(zod 4.x),拒多余字段;`code` 空 / > 200KB 报 `-32602`
- 渲染超时:10s(`MERMAID_RENDER_TIMEOUT_MS` 可配),超时报 `-32001 render_timeout`(retryable: false)
- Mermaid 解析错误:0 重试(确定性),抛 `-32002 render_failed`(retryable: false)
- jsdom 初始化失败:1 次重试,仍失败抛 `-32003 jsdom_init_failed`(retryable: false)
- ASCII 失败:0 重试,进 `warnings: ["ascii_failed: <reason>"]`,不中断
- 存储写失败:1 次重试(仅瞬时错 EAGAIN),仍失败抛 `-32004 storage_write_failed`(retryable: true)
- 存储读失败:5s 超时,抛 `-32005 storage_read_failed`(retryable: true)
- Sweep:仅日志 + counter,不中断;`store.json` 损坏时从空开始
- Port 冲突(HTTP 模式):5300 → 5301 → 5302 → fail,启动日志记录最终端口
- MCP 协议违规:stderr 警告,不崩;client 断开 stdout EPIPE 时放弃 in-flight render
- HTTP body limit:1MB;连接超时 30s(`server.headersTimeout`)
- 优雅退出:SIGINT/SIGTERM 触发,3s drain 后 exit
- 存储原子写:`tmp + rename` 替换 `store.json` / `counters.json`,`fs.rename` POSIX 原子;Windows 上 `fs.rename` 行为略不同但仍是覆盖语义

## Risks and Unknowns

- mermaid-ascii 在 class/state/复杂 sequence 下挂 — best-effort 兜底 + M001 `warnings` 显式;Mermaid 11 升级是否破坏兼容性待 M001 验证
- zod 4.x API 与 `@modelcontextprotocol/sdk@1.29` 类型协同 — 需在 S02 早期任务中验证
- `fs.rename` 在 Windows 上的原子性边界(开发机 + 用户覆盖 Windows / macOS / Linux) — 需在 S01 测试覆盖
- OpenClaw 无原生 MCP(架构文档明确指出),S04 集成 setup 重;Hermes / opencode 集成 doc 字段静态检查只做,不实跑
- jsdom 25 冷启动偶发失败 → M001 1 次重试兜底(2 次以上基本是环境问题)
- 5 客户端调方零回归需 S04 实际跑通确认(Claude Code + gsd-pi 实跑,其他 3 静态)
- 真实集成测试在 Windows 环境下可能受 PowerShell 行为影响(eval 4 涉及 mermaid 解析错误信息显示)

## Existing Codebase / Prior Art

- `src/server.mjs` — stdio MCP + 可选 HTTP,单进程双协议
- `src/render.mjs` — mermaid 11 + jsdom 25 + mermaid-ascii 1.0
- `src/storage.mjs` — 7-day TTL + pin + JSON index + blob I/O
- `public/view.html` — 自包含 HTML viewer(zoom / pan / pin / download)
- `evals.xml` — 10 个 eval 题目,M001 转为可运行测试
- `bin/start.sh` / `bin/stop.sh` / `.ps1` — lifecycle 脚本
- `docs/integration/{claude-code,gsd-pi,hermes,openclaw,opencode}.md` — 5 客户端集成指引
- `docs/{api,architecture,mcp-protocol}.md` — API/架构/协议文档
- `data/store.json` — 当前索引(已有 1 条 sample)
- `data/blobs/` — 渲染产物目录

## Relevant Requirements

- M001 推进:R001-R029(全部 29 个 active)
- M001 不推进(deferred):R030-R035(6 个,M002+ 接手)
- M001 不推进(out-of-scope):R036-R041(6 个)

## Scope

### In Scope

- 测试 + CI 基础设施(vitest + GitHub Actions + 10 evals + 覆盖率)
- MCP 工具扩展(从 1 个到 7 个,CRUD 完整)
- 存储抽象为 pluggable(LocalFsStorage 默认,interface 留口)
- 可观测性(structured stderr JSON + /health metrics + 持久化 counters)
- 错误合约统一(`error: {code, message, retryable}` + `warnings: string[]`)
- 真实集成验证(Claude Code + gsd-pi 实际调)
- 文档更新(README + CHANGELOG → v0.2.0)
- 性能:1-5KB 源码 < 2s;50KB < 5s

### Out of Scope / Non-Goals

- 重写 Mermaid 解析(沿用 `mermaid@11`)
- 交互式 TUI 应用
- HTTP-only 协议分支、SSE、streamable HTTP
- 暴露 5300 以外的端口
- 账户 / 云存储 / 订阅(M002+)
- OpenClaw 原生 MCP 集成(沿用 workaround)
- MCP progress 协议(M002 视情况)
- PNG 导出验证(M002 视情况)

## Technical Constraints

- Node 22+(`engines.node >= 22`,CI 矩阵 22+24)
- ESM-only(`"type": "module"`)
- stderr-only 日志(保留 stdout 给 JSON-RPC)
- 纯 local,无网络
- 文件级存储(local FS,no DB)
- 5 客户端零回归
- 单进程(不引入多进程并行)

## Integration Points

- `@modelcontextprotocol/sdk@1.29` — MCP 协议实现
- `mermaid@11.15` + `jsdom@25.0.1` — Mermaid 渲染管线
- `mermaid-ascii@1.0` — TUI ASCII 输出
- `vitest`(M001 新增)— 测试框架
- `zod@4`(M001 新增)— 校验 + 错误分类
- GitHub Actions — CI
- 5 LLM 客户端(gsd-pi / Claude Code / opencode / Hermes / OpenClaw)— 集成验证
- 文件系统(`data/`,`data/blobs/`,`data/counters.json`)— 持久化

## Testing Requirements

- 单元(vitest):`storage.mjs`(put/get/remove/search/sweep/损坏恢复/原子写)、`render.mjs`(空/超长/解析失败/ASCII 失败/超时)、HTTP 路由(/view /pin /raw/svg /health)、JSON Schema 校验
- 集成:spawn `node src/server.mjs`,stdio JSON-RPC 真实调用全 7 工具
- eval:10 个 evals.xml 条目转 vitest 测试,每条用真实 mermaid 源码跑
- 覆盖率:≥ 80% 行,CI 强制门槛
- 端到端(S04):MCP Inspector 跑全 7 工具 + Claude Code + gsd-pi 真集成冒烟
- 持久化验证(S03):计数器落盘 + 重启续值
- 故障注入(S03):渲染超时、ASCII 失败、port 冲突、jsdom 偶发失败 真实触发过

## Acceptance Criteria

### S01 测试 + CI foundation

- `npm test` 跑通 10 evals + 单元测试
- GitHub Actions 在 Node 22 + 24 全绿
- 覆盖率报告 ≥ 80% 且 CI 门槛通过
- 覆盖率徽章(可选)加入 README

### S02 MCP 工具(7 个)

- stdio MCP 列出 7 工具
- `render_mermaid({code, title})` 写入 title 到 entry + view.html
- `pin_mermaid({id})` 后 sweep 不删
- `unpin_mermaid({id})` 恢复 7 天 TTL
- `list_diagrams({limit, cursor, pinned?})` 翻页+过滤
- `get_diagram({id, include?})` 完整对象,`include` 控制返回字段
- `delete_mermaid({id})` 真删 store + blob,id 不存在返 -32005
- `search_diagrams({query, limit, cursor, pinned?})` 命中 title 优先
- storage pluggable 接口就绪(LocalFsStorage 默认)

### S03 可观测性

- stderr 单行 JSON 日志,字段稳定(ts / level / event / code / id)
- `/health` 返 `counters` + `last_render_ms` + `last_errors`(5 条环形)+ 现有字段
- `data/counters.json` 持久化,启动 load,increment save
- 10s 渲染超时实际触发(可注入 mock)
- jsdom 初始化 1 次重试实际触发(可注入 mock)
- 写失败 1 次重试实际触发(可注入 mock)
- 错误码 → counter 映射齐全(-32001..-32009)

### S04 集成验证

- MCP Inspector 跑全 7 工具,所有契约满足
- Claude Code 真启动 + 真调一次 `render_mermaid` 拿到 ASCII + 链接
- gsd-pi 真启动 + 真调一次 `render_mermaid` 拿到 ASCII + 链接
- Hermes / opencode 集成 doc 字段静态检查通过
- OpenClaw 集成 doc 字段静态检查通过(workaround 路径)
- CHANGELOG 写 v0.2.0(列出 7 工具 / 计数器 / 测试基线)
- README 更新(7 工具表 + 快速开始 + 故障排查)

## Open Questions

- 持久化 counters 的写频率:每次 increment 写一次 FS(简单)还是聚合写(更省 IO)?倾向简单(每次写),`tmp+rename` 已原子,开销低
- 5 客户端真集成是否需要 docker 化(隔离环境)— 倾向不需要,本地 mcp.json 注册足够
- `view.html` 的"download"按钮目前指向什么(SVG / PNG)— 需要查源码确认;M001 暂不涉及 PNG 验证,放到 M002+
