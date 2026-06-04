# M001: v0.2.0 收口

**Vision:** 把 v0.1.0 单工具版收口为 v0.2.0:补齐测试与 CI、扩展 MCP 工具到 7 个(CRUD 完整)、建立可观测性(stderr JSON 与 /health metrics 与持久化 counters)、真实集成验证(Claude Code 与 gsd-pi 实调)。保留所有现有能力,零回归。

## Success Criteria

- 4 slice 全 done
- 10 evals 真实 exec 全过
- 覆盖率 ≥ 80% 且 CI 绿 Node 22 加 24
- stdio MCP 真实 roundtrip 全 7 工具
- /health 真实返 metrics 非 mock
- storage pluggable 抽象就绪 LocalFsStorage 默认 OssStorage M002
- 5 客户端零回归 Claude Code gsd-pi 实跑 其他静态
- README 与 CHANGELOG v0.2.0
- 无新增 deferred requirements 若发现 M001 不接

## Slices

- [x] **S01: Test + CI foundation** `risk:medium` `depends:[]`
  > After this: npm test 跑通 10 evals 与单元测试;GitHub Actions Node 22+24 全绿;覆盖率报告 ≥ 80% 且 CI 门槛通过

- [x] **S02: MCP tools - 7 tools, CRUD complete** `risk:high` `depends:[S01]`
  > After this: stdio MCP 列 7 工具(render 与 6 资源管理);render 接可选 title 入参;pin_mermaid 后 sweep 不删;list_diagrams 与 search_diagrams 翻页过滤与 title 命中优先;get_diagram 完整对象含 title;delete_mermaid 真删;storage pluggable 接口就绪(LocalFsStorage 默认)

- [ ] **S03: Observability - logs, health, counters, error contract** `risk:medium` `depends:[S01]`
  > After this: stderr 单行 JSON 日志(字段稳定 ts 与 level 与 event 与 code 与 id);/health 返 counters 与 last_render_ms 与 last_errors(5 条环形)与现有字段;data/counters.json 持久化启动 load increment save(tmp+rename 原子);10s 渲染超时可注入触发;jsdom 初始化 1 次重试可注入触发;写失败 1 次重试可注入触发;错误码 -32001 到 -32009 映射到 counter 齐全

- [ ] **S04: Integration verification - MCP Inspector and 5-client real smoke** `risk:high` `depends:[S02,S03]`
  > After this: MCP Inspector 跑全 7 工具所有契约满足;Claude Code 真启动与真调一次 render_mermaid 拿到 ASCII 与链接;gsd-pi 真启动与真调一次 render_mermaid 拿到 ASCII 与链接;Hermes 与 opencode 与 OpenClaw 集成 doc 字段静态检查;CHANGELOG 写 v0.2.0(列出 7 工具与计数器与测试基线);README 更新(7 工具表与快速开始与故障排查)

## Boundary Map

S01 produces: vitest config + npm test script + test fixtures (storage empty/populated/corrupted, render valid/malformed/oversized) + tests/ directory with eval tests and unit tests + .github/workflows/ci.yml + 10 eval tests passing + ≥80% coverage baseline; consumes nothing (first slice)
S02 produces: 7 MCP tools with zod-validated schemas + StorageBackend interface + LocalFsStorage implementation (replaces current Storage class) + entry schema with title field + remove(id) and search(query, opts) methods on storage + all 6 new tools pass unit + integration tests + existing render_mermaid extended with title parameter; consumes S01 test infrastructure
S03 produces: structured logger (writes JSON to stderr) + data/counters.json schema and persistence + extended /health response + render timeout wrapper (10s) + jsdom init retry (1 attempt) + storage write retry (1 attempt on transient errors) + error classification module (zod-based) + all error codes -32001 to -32009 mapped to counters; consumes S01 test infrastructure + S02 7 tools (for error contract integration)
S04 produces: updated README.md (7-tool table, quick start, troubleshooting) + updated CHANGELOG.md (v0.2.0 entry) + MCP Inspector test scripts + real client integration test logs (Claude Code + gsd-pi) + S04 final acceptance report; consumes S01 + S02 + S03 deliverables
