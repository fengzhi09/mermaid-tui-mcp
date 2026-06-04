# Requirements

This file is the explicit capability and coverage contract for the project.

## Active

### R001 — 暴露 `render_mermaid({code, title?})` MCP 工具。code 必填 ≤200KB,title 可选 ≤200 字。成功返回 {id, ascii, fileLink, httpLink, title, elapsed_ms, warnings}。title 存入 entry 元数据并在 view.html 显示,可供 search_diagrams 搜索。
- Class: core-capability
- Status: active
- Description: 暴露 `render_mermaid({code, title?})` MCP 工具。code 必填 ≤200KB,title 可选 ≤200 字。成功返回 {id, ascii, fileLink, httpLink, title, elapsed_ms, warnings}。title 存入 entry 元数据并在 view.html 显示,可供 search_diagrams 搜索。
- Why it matters: 项目核心能力;所有 LLM 客户端的唯一入口;title 入参把搜索锚点从纯 code 提到 title,体验更直接
- Source: user
- Primary owning slice: M001/S02
- Validation: mapped

### R002 — 渲染产物默认 7 天后 sweep 删除;pin 标记的保留。Sweep 在 load、put、每小时触发
- Class: continuity
- Status: active
- Description: 渲染产物默认 7 天后 sweep 删除;pin 标记的保留。Sweep 在 load、put、每小时触发
- Why it matters: 长期使用避免存储无限增长,pin 保留重要图
- Source: user
- Primary owning slice: M001/S02
- Validation: mapped

### R003 — data/blobs/<id>.html 自包含(SVG 内联),file:// 在浏览器打开即可看图,无需运行 server
- Class: differentiator
- Status: active
- Description: data/blobs/<id>.html 自包含(SVG 内联),file:// 在浏览器打开即可看图,无需运行 server
- Why it matters: 用户离线/无 server 场景下也能看图;差异化卖点
- Source: user
- Primary owning slice: M001/S02
- Validation: mapped

### R004 — MERMAID_RENDERER_HTTP=1 启用 HTTP 端口 5300(env 可配),4 个端点 /view /pin /raw/svg /health
- Class: launchability
- Status: active
- Description: MERMAID_RENDERER_HTTP=1 启用 HTTP 端口 5300(env 可配),4 个端点 /view /pin /raw/svg /health
- Why it matters: 浏览器集成 + pin HTTP API
- Source: user
- Primary owning slice: M001/S02
- Validation: mapped

### R005 — 支持 gsd-pi / Claude Code / opencode / Hermes / OpenClaw 5 个 LLM 客户端通过 stdio MCP 集成
- Class: launchability
- Status: active
- Description: 支持 gsd-pi / Claude Code / opencode / Hermes / OpenClaw 5 个 LLM 客户端通过 stdio MCP 集成
- Why it matters: 项目多客户端是核心定位;S04 真实集成验证
- Source: user
- Primary owning slice: M001/S04
- Validation: mapped

### R006 — 引入 vitest 测试框架;10 个 evals.xml 条目转可运行 vitest 测试,每条用真实 mermaid 源码跑
- Class: quality-attribute
- Status: active
- Description: 引入 vitest 测试框架;10 个 evals.xml 条目转可运行 vitest 测试,每条用真实 mermaid 源码跑
- Why it matters: 把"评测基线"从文档变成可执行测试,后续回归有底
- Source: user
- Primary owning slice: M001/S01
- Validation: mapped

### R007 — GitHub Actions 在 Node 22 + 24 双版本跑测试;PR + push 触发;覆盖率门槛强制
- Class: quality-attribute
- Status: active
- Description: GitHub Actions 在 Node 22 + 24 双版本跑测试;PR + push 触发;覆盖率门槛强制
- Why it matters: 覆盖 engines.node 上下界;CI 是质量基线
- Source: user
- Primary owning slice: M001/S01
- Validation: mapped

### R008 — 所有日志改 stderr 单行 JSON,字段稳定(ts/level/event/code/id)
- Class: failure-visibility
- Status: active
- Description: 所有日志改 stderr 单行 JSON,字段稳定(ts/level/event/code/id)
- Why it matters: Agent-first 可观测;LLM/运维/agent 都能 parse
- Source: user
- Primary owning slice: M001/S03
- Validation: mapped

### R009 — /health 端点返 {counters, last_render_ms, last_errors[5]} 在现有字段之外
- Class: failure-visibility
- Status: active
- Description: /health 端点返 {counters, last_render_ms, last_errors[5]} 在现有字段之外
- Why it matters: 健康检查 + ops 信号;5 条环形保留最近错误
- Source: user
- Primary owning slice: M001/S03
- Validation: mapped

### R010 — 计数器(render_total / render_errors / ascii_failures / storage_write_retries / sweep_runs / sweep_removed)落 data/counters.json,启动 load,increment 时 tmp+rename 原子写
- Class: continuity
- Status: active
- Description: 计数器(render_total / render_errors / ascii_failures / storage_write_retries / sweep_runs / sweep_removed)落 data/counters.json,启动 load,increment 时 tmp+rename 原子写
- Why it matters: 重启后健康检查有连续性
- Source: user
- Primary owning slice: M001/S03
- Validation: mapped

### R011 — {id} → {id, pinned: true, elapsed_ms, warnings};id 不存在返 -32005;写失败 -32004
- Class: core-capability
- Status: active
- Description: {id} → {id, pinned: true, elapsed_ms, warnings};id 不存在返 -32005;写失败 -32004
- Why it matters: 解决 eval 9 缺口(LLM 调不到 pin)
- Source: user
- Primary owning slice: M001/S02
- Validation: mapped

### R012 — {id} → {id, pinned: false, ...};与 pin_mermaid 对偶
- Class: core-capability
- Status: active
- Description: {id} → {id, pinned: false, ...};与 pin_mermaid 对偶
- Why it matters: 配对;CRUD 中的 Update
- Source: user
- Primary owning slice: M001/S02
- Validation: mapped

### R013 — {limit?, cursor?, pinned?} → {items, nextCursor, elapsed_ms, warnings};按 createdAt 降序;limit 默认 20 上限 100
- Class: core-capability
- Status: active
- Description: {limit?, cursor?, pinned?} → {items, nextCursor, elapsed_ms, warnings};按 createdAt 降序;limit 默认 20 上限 100
- Why it matters: LLM 查历史图;Read 批
- Source: user
- Primary owning slice: M001/S02
- Validation: mapped

### R014 — {id, include?} → {id, title, code, ascii, svg, createdAt, lastAccessedAt, pinned, sourceLength, elapsed_ms, warnings};include 控制返回字段
- Class: core-capability
- Status: active
- Description: {id, include?} → {id, title, code, ascii, svg, createdAt, lastAccessedAt, pinned, sourceLength, elapsed_ms, warnings};include 控制返回字段
- Why it matters: LLM 凭 id 取回完整内容;Read 单
- Source: user
- Primary owning slice: M001/S02
- Validation: mapped

### R015 — 渲染超过 MERMAID_RENDER_TIMEOUT_MS(默认 10000)抛 -32001 render_timeout (retryable: false)
- Class: failure-visibility
- Status: active
- Description: 渲染超过 MERMAID_RENDER_TIMEOUT_MS(默认 10000)抛 -32001 render_timeout (retryable: false)
- Why it matters: 防 hang;可注入测
- Source: user
- Primary owning slice: M001/S03
- Validation: mapped

### R016 — HTTP 启动遇 EADDRINUSE 自动尝试 5301、5302,3 次后 fail
- Class: failure-visibility
- Status: active
- Description: HTTP 启动遇 EADDRINUSE 自动尝试 5301、5302,3 次后 fail
- Why it matters: 多实例共存;不直接崩
- Source: user
- Primary owning slice: M001/S03
- Validation: mapped

### R017 — writeFile 遇 EAGAIN 等瞬时错重试 1 次,终态 ENOSPC/EACCES 直接 fail (-32004)
- Class: failure-visibility
- Status: active
- Description: writeFile 遇 EAGAIN 等瞬时错重试 1 次,终态 ENOSPC/EACCES 直接 fail (-32004)
- Why it matters: 局部故障恢复;终态错不浪费重试
- Source: user
- Primary owning slice: M001/S03
- Validation: mapped

### R018 — getMermaid() 初始化失败重试 1 次,仍失败抛 -32003 jsdom_init_failed
- Class: failure-visibility
- Status: active
- Description: getMermaid() 初始化失败重试 1 次,仍失败抛 -32003 jsdom_init_failed
- Why it matters: 冷启动偶发失败兜底
- Source: user
- Primary owning slice: M001/S03
- Validation: mapped

### R019 — StorageBackend interface(put/get/readSvg/setPinned/remove/search/sweep/load/save/stats)+ LocalFsStorage 默认实现;MERMAID_RENDERER_BACKEND env 切换;M002 OssStorage 复用同一 interface
- Class: constraint
- Status: active
- Description: StorageBackend interface(put/get/readSvg/setPinned/remove/search/sweep/load/save/stats)+ LocalFsStorage 默认实现;MERMAID_RENDERER_BACKEND env 切换;M002 OssStorage 复用同一 interface
- Why it matters: M002 云存储(OSS)不重写 storage.mjs
- Source: user
- Primary owning slice: M001/S02
- Validation: mapped

### R020 — 成功结果 {...payload, elapsed_ms, warnings?: string[]};失败 isError: true + error: {code, message, retryable}
- Class: integration
- Status: active
- Description: 成功结果 {...payload, elapsed_ms, warnings?: string[]};失败 isError: true + error: {code, message, retryable}
- Why it matters: 7 工具统一错误合约,LLM 可编程响应
- Source: user
- Primary owning slice: M001/S03
- Validation: mapped

### R021 — 全 local,无 fetch/http/websocket 外部调用;端口 127.0.0.1 local-only
- Class: compliance/security
- Status: active
- Description: 全 local,无 fetch/http/websocket 外部调用;端口 127.0.0.1 local-only
- Why it matters: 隐私 + 安全;用户信任
- Source: user
- Primary owning slice: M001/S04
- Validation: mapped
- Notes: S04 回归验证

### R022 — render_mermaid 拒绝 > 200KB code,返 -32602
- Class: constraint
- Status: active
- Description: render_mermaid 拒绝 > 200KB code,返 -32602
- Why it matters: 防 DoS;mermaid 库实际承载边界
- Source: user
- Primary owning slice: M001/S02
- Validation: mapped

### R023 — mermaid 11 securityLevel: 'loose' + view.html 中 escapeHtml 转义 code 字段;无 exec/eval
- Class: compliance/security
- Status: active
- Description: mermaid 11 securityLevel: 'loose' + view.html 中 escapeHtml 转义 code 字段;无 exec/eval
- Why it matters: 渲染产物中 mermaid 源码被展示,转义防 XSS
- Source: user
- Primary owning slice: M001/S04
- Validation: mapped
- Notes: S04 回归验证

### R024 — SIGINT/SIGTERM 触发,3s drain 后 exit
- Class: operability
- Status: active
- Description: SIGINT/SIGTERM 触发,3s drain 后 exit
- Why it matters: in-flight render 不被打断
- Source: user
- Primary owning slice: M001/S04
- Validation: mapped
- Notes: S04 回归验证

### R025 — mermaid-ascii 失败时进 warnings,塞 [mermaid-ascii failed: <reason>] 前缀,render 不中断
- Class: quality-attribute
- Status: active
- Description: mermaid-ascii 失败时进 warnings,塞 [mermaid-ascii failed: <reason>] 前缀,render 不中断
- Why it matters: ASCII 是 TUI 增强,失败不能拖垮 SVG/HTML
- Source: user
- Primary owning slice: M001/S02
- Validation: mapped

### R026 — fileLink 路径在 Windows / macOS / Linux 三平台正确(file:///C:/.../ 或 file:///Users/.../ 等)
- Class: operability
- Status: active
- Description: fileLink 路径在 Windows / macOS / Linux 三平台正确(file:///C:/.../ 或 file:///Users/.../ 等)
- Why it matters: 跨平台用户都能 file:// 打开
- Source: user
- Primary owning slice: M001/S04
- Validation: mapped
- Notes: S04 回归验证

### R027 — S04 阶段 10 个 evals.xml 题目全部真实 exec 通过(vitest 跑)
- Class: quality-attribute
- Status: active
- Description: S04 阶段 10 个 evals.xml 题目全部真实 exec 通过(vitest 跑)
- Why it matters: M001 收口证明
- Source: user
- Primary owning slice: M001/S04
- Validation: mapped

### R028 — {id} → {id, deleted: true, elapsed_ms, warnings};id 不存在 -32005(严格 404,非幂等)
- Class: core-capability
- Status: active
- Description: {id} → {id, deleted: true, elapsed_ms, warnings};id 不存在 -32005(严格 404,非幂等)
- Why it matters: CRUD 闭环;LLM 主动清理
- Source: user
- Primary owning slice: M001/S02
- Validation: mapped

### R029 — {query, limit?, cursor?, pinned?} → {items[{id, title, titleMatch, snippet, ...}], nextCursor, ...};对 title + code 大小写不敏感子串匹配;titleMatch 优先排序
- Class: core-capability
- Status: active
- Description: {query, limit?, cursor?, pinned?} → {items[{id, title, titleMatch, snippet, ...}], nextCursor, ...};对 title + code 大小写不敏感子串匹配;titleMatch 优先排序
- Why it matters: LLM 凭关键词找回旧图;Read 批+过滤
- Source: user
- Primary owning slice: M001/S02
- Validation: mapped

## Validated

## Deferred

### R030 — 用户账户 + 登录 + 配额管理(M002+ 候选)
- Class: admin/support
- Status: deferred
- Description: 用户账户 + 登录 + 配额管理(M002+ 候选)
- Why it matters: 云存储 + 订阅的依赖
- Source: user
- Primary owning slice: none
- Validation: unmapped
- Notes: 永久存储若涉及 OSS + 订阅费用,需要账户层

### R031 — OssStorage 实现 StorageBackend interface(M001 留口),支持阿里云 OSS / AWS S3 / MinIO
- Class: continuity
- Status: deferred
- Description: OssStorage 实现 StorageBackend interface(M001 留口),支持阿里云 OSS / AWS S3 / MinIO
- Why it matters: 永久存储、跨设备访问
- Source: user
- Primary owning slice: none
- Validation: unmapped
- Notes: 可能涉及订阅费用,用户已明确放 M002+

### R032 — 订阅 + 计费(配合云存储)
- Class: admin/support
- Status: deferred
- Description: 订阅 + 计费(配合云存储)
- Why it matters: 商业化基础
- Source: user
- Primary owning slice: none
- Validation: unmapped

### R033 — 渲染 > 2s 时 emit notifications/progress 协议
- Class: quality-attribute
- Status: deferred
- Description: 渲染 > 2s 时 emit notifications/progress 协议
- Why it matters: 渲染真变慢时给客户端进度反馈
- Source: user
- Primary owning slice: none
- Validation: unmapped
- Notes: M001 改用 elapsed_ms 字段(0 协议开销);真需要再上

### R034 — OpenClaw 原生支持 MCP 协议(目前是 workaround)
- Class: integration
- Status: deferred
- Description: OpenClaw 原生支持 MCP 协议(目前是 workaround)
- Why it matters: 真原生支持减少 setup 摩擦
- Source: user
- Primary owning slice: none
- Validation: unmapped
- Notes: 依赖 OpenClaw 上游;不在我们控制范围

### R035 — view.html 的 download 按钮生成 PNG 当前未验证
- Class: quality-attribute
- Status: deferred
- Description: view.html 的 download 按钮生成 PNG 当前未验证
- Why it matters: 用户可能依赖 PNG 导出(嵌入文档/分享)
- Source: inferred
- Primary owning slice: none
- Validation: unmapped
- Notes: 需要在浏览器自动化中验证(M001 无浏览器测试 setup)

## Out of Scope

### R036 — 不做 SaaS 渲染服务
- Class: anti-feature
- Status: out-of-scope
- Description: 不做 SaaS 渲染服务
- Why it matters: 项目定位 local-only,云服务越界
- Source: inferred
- Primary owning slice: none
- Validation: n/a
- Notes: 显式排除

### R037 — 不引入 SSE / streamable HTTP,MCP 维持 stdio only
- Class: anti-feature
- Status: out-of-scope
- Description: 不引入 SSE / streamable HTTP,MCP 维持 stdio only
- Why it matters: local-only 无收益;opencode 已知 SSE 问题
- Source: user
- Primary owning slice: none
- Validation: n/a
- Notes: 显式排除(用户 Layer 1 决定)

### R038 — 不做交互式 TUI 应用
- Class: anti-feature
- Status: out-of-scope
- Description: 不做交互式 TUI 应用
- Why it matters: 项目是被动渲染回退,不是 TUI 应用
- Source: user
- Primary owning slice: none
- Validation: n/a
- Notes: 显式排除

### R039 — 不做账户 / 鉴权 / 多用户
- Class: anti-feature
- Status: out-of-scope
- Description: 不做账户 / 鉴权 / 多用户
- Why it matters: single-user local tool,鉴权无意义
- Source: inferred
- Primary owning slice: none
- Validation: n/a
- Notes: 显式排除

### R040 — 不支持跨主机网络存储(NFS / SMB)
- Class: anti-feature
- Status: out-of-scope
- Description: 不支持跨主机网络存储(NFS / SMB)
- Why it matters: local-only,网络存储引入复杂度
- Source: inferred
- Primary owning slice: none
- Validation: n/a
- Notes: 显式排除

### R041 — 不重写 Mermaid 解析
- Class: anti-feature
- Status: out-of-scope
- Description: 不重写 Mermaid 解析
- Why it matters: 沿用 mermaid@11,生态成熟
- Source: user
- Primary owning slice: none
- Validation: n/a
- Notes: 显式排除

## Traceability

| ID | Class | Status | Primary owner | Supporting | Proof |
|---|---|---|---|---|---|
| R001 | core-capability | active | M001/S02 | none | mapped |
| R002 | continuity | active | M001/S02 | none | mapped |
| R003 | differentiator | active | M001/S02 | none | mapped |
| R004 | launchability | active | M001/S02 | none | mapped |
| R005 | launchability | active | M001/S04 | none | mapped |
| R006 | quality-attribute | active | M001/S01 | none | mapped |
| R007 | quality-attribute | active | M001/S01 | none | mapped |
| R008 | failure-visibility | active | M001/S03 | none | mapped |
| R009 | failure-visibility | active | M001/S03 | none | mapped |
| R010 | continuity | active | M001/S03 | none | mapped |
| R011 | core-capability | active | M001/S02 | none | mapped |
| R012 | core-capability | active | M001/S02 | none | mapped |
| R013 | core-capability | active | M001/S02 | none | mapped |
| R014 | core-capability | active | M001/S02 | none | mapped |
| R015 | failure-visibility | active | M001/S03 | none | mapped |
| R016 | failure-visibility | active | M001/S03 | none | mapped |
| R017 | failure-visibility | active | M001/S03 | none | mapped |
| R018 | failure-visibility | active | M001/S03 | none | mapped |
| R019 | constraint | active | M001/S02 | none | mapped |
| R020 | integration | active | M001/S03 | none | mapped |
| R021 | compliance/security | active | M001/S04 | none | mapped |
| R022 | constraint | active | M001/S02 | none | mapped |
| R023 | compliance/security | active | M001/S04 | none | mapped |
| R024 | operability | active | M001/S04 | none | mapped |
| R025 | quality-attribute | active | M001/S02 | none | mapped |
| R026 | operability | active | M001/S04 | none | mapped |
| R027 | quality-attribute | active | M001/S04 | none | mapped |
| R028 | core-capability | active | M001/S02 | none | mapped |
| R029 | core-capability | active | M001/S02 | none | mapped |
| R030 | admin/support | deferred | none | none | unmapped |
| R031 | continuity | deferred | none | none | unmapped |
| R032 | admin/support | deferred | none | none | unmapped |
| R033 | quality-attribute | deferred | none | none | unmapped |
| R034 | integration | deferred | none | none | unmapped |
| R035 | quality-attribute | deferred | none | none | unmapped |
| R036 | anti-feature | out-of-scope | none | none | n/a |
| R037 | anti-feature | out-of-scope | none | none | n/a |
| R038 | anti-feature | out-of-scope | none | none | n/a |
| R039 | anti-feature | out-of-scope | none | none | n/a |
| R040 | anti-feature | out-of-scope | none | none | n/a |
| R041 | anti-feature | out-of-scope | none | none | n/a |

## Coverage Summary

- Active requirements: 29
- Mapped to slices: 29
- Validated: 0
- Unmapped active requirements: 0
