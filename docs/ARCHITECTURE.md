# 架构说明

SubHub 由三部分组成：**浏览器前端**（Vue 3 + Naive UI）、**Node 网关**（零依赖）、**转换引擎**（subconverter）。网关是唯一对外入口，负责鉴权、来源归一化、模板托管、缓存与订阅签发；引擎只做格式转换，不对公网暴露。

```text
                    ┌─────────────────────────────────────────────┐
   Browser ────────▶│ gateway  :8080                              │
   (Vue SPA)        │  ├─ /api/*      管理接口（会话 / 权限）      │
                    │  ├─ /s/<token>  固定订阅                     │
                    │  ├─ /c/<payload>临时链接                    │
                    │  ├─ /tpl/*.ini  模板（引擎回源）             │
                    │  ├─ /src/<id>   归一化订阅源（引擎回源）     │
                    │  └─ /legacy/*   旧版界面                    │
                    └───────────────┬─────────────────────────────┘
                                    │ HTTP（内网）
                                    ▼
                    ┌─────────────────────────────────────────────┐
                    │ subconverter :25500                         │
                    │  按 target 输出 mihomo / sing-box / Surge…  │
                    └─────────────────────────────────────────────┘
```

## 请求流程（订阅转换）

1. 前端提交来源（订阅 URL / 节点 / 配置文件）、模板、规则集、目标客户端。
2. 网关校验来源（`security.js`：协议、长度、私网/回环/元数据地址），逐个抓取并归一化（`sources.js`）：
   - 明文链接列表 → Base64；
   - Clash YAML / sing-box JSON → 原样；
   - 节点数组 → 生成 YAML。
3. 归一化结果注册到内存 `SourceStore`，得到 `/src/<id>` 地址（10 分钟 TTL）。
4. 若选中的规则集只提供原始 yaml（非 mihomo `.mrs` / sing-box `.srs`），网关会展开成带类型的规则文本，再托管成一条 `/src/<id>`，作为单条 `ruleset=` 注入 ini（避免引擎的 ruleset 数量上限）。
5. 模板以 `/tpl/<name>.ini` 或内联模板 `/tpl-inline/<id>.ini` 提供给引擎；转换参数通过 query 传递（不挂载 `pref.ini`）。
6. 引擎返回配置正文；mihomo / sing-box 再做基础配置与 DNS 的原生合并（`layers.js`）。
7. 结果按 `token + revision + target + 模板/资源库版本` 缓存；Surge 的 `#!MANAGED-CONFIG` 首行会被改写成对外订阅地址。

## 模块

| 文件 | 职责 |
| --- | --- |
| `gateway/server.js` | HTTP 路由、鉴权、订阅、API、静态资源、错误处理 |
| `lib/auth.js` | SQLite 账号、会话、注册码、角色与权限计算 |
| `lib/settings.js` | 引擎模式（内置/远程）、远程地址与 Token |
| `lib/icons.js` | 内置图标、自定义图标（dataUrl 校验与上限） |
| `lib/catalog.js` | 2183 条规则目录：索引、中文搜索、在线更新、yaml 展开 |
| `lib/library.js` | 规则集 / 基础配置 / DNS / 来源仓库的持久化 |
| `lib/templates.js` | `[custom]` ini 解析/生成、模板 CRUD、mtime 缓存 |
| `lib/layers.js` | mihomo rule-providers、sing-box rule_set、ini ruleset 注入、基础/DNS 合并 |
| `lib/engine.js` | subconverter 客户端、输出校验、MANAGED-CONFIG 改写 |
| `lib/sources.js` | 订阅抓取、格式识别、Base64 归一化、SourceStore |
| `lib/security.js` | SSRF 守卫、限流器、URL 校验 |
| `lib/profiles.js` | 固定订阅模型与链接生成 |
| `lib/nodes.js` | 节点解析、规范化、YAML 序列化 |
| `lib/cache.js` | 转换结果 TTL 缓存（LRU + 字节上限） |
| `lib/util.js` | 日志、HTTP 响应、哈希、错误类型 |

前端：`web/src/App.vue`（壳与登录）、`views/ConvertView.vue`（工作台）、`views/LibraryView.vue`（资源库）、`views/ProfilesView.vue`（订阅）、`views/SystemView.vue`（引擎/账号/日志）、`components/PreviewPane.vue`（预览）、`components/IconPicker.vue`、`state.js`（全局状态与权限）。

## 存储

均位于 `CONFIG_DIR`（容器内 `/config`，宿主机默认 `./data`）：

| 文件 | 位置 | 内容 |
| --- | --- | --- |
| `subhub.db` | `/config` | SQLite：账号、注册码、meta（WAL） |
| `settings.json` | `/config` | 引擎模式与远程配置（Token 打码返回） |
| `profiles.json` | `/config` | 固定订阅 |
| `icons.json` | `/config/icons` | 自定义图标 |
| `templates/*.ini` | `/config/templates` | 模板（首次启动从镜像 seed 复制） |
| `library.json` | `/config/rules` | 规则集 / 基础 / DNS / 仓库 |
| `uploads/` | `/config/rules/uploads` | 本地上传的规则文件 |
| `rules-catalog.json` | `/config/cache` | 规则目录（启动时从 seed 升级，可在线更新） |

## 权限模型

10 项权限：`convert`、`subscribe`、`templates:write`、`library:write`、`profiles:write`、`icons:write`、`catalog:refresh`、`engine:write`、`logs:read`、`users:manage`。

- `admin`：全部；
- `operator`：除 `engine:write`、`users:manage` 外全部；
- `user`：`convert`、`subscribe`；
- 账号可保存自定义权限集，覆盖角色默认；`admin` 始终全量。
- `ADMIN_KEY` 作为兜底凭据，命中时视为全量权限（供脚本）。

## 安全边界

- 所有出站抓取必须先过 `assertSourceUrl`（禁 `file://`、私网、回环、链路本地、元数据域名）；`ALLOW_PRIVATE_SOURCES=true` 仅放开私网判定。
- 模板名、资源库 id、节点字段、图标 dataUrl 均有长度/格式限制；模板 ≤256KB，订阅源 ≤8MB，图标 ≤96KB。
- 订阅与转换有独立限流；管理接口按权限校验。
- HTML 响应带 CSP；静态资源带 `nosniff`、`no-referrer`；会话 Cookie `HttpOnly` + `SameSite=Lax`。
- 密码 `scrypt`（16 字节 salt，64 字节 hash），比较使用 `timingSafeEqual`。

## 扩展点

- **新增客户端**：`lib/targets.js` 增加目标（engine、contentType、accent），前端自动读取 `/api/state.targets`。
- **新增规则源**：在 `seed/library.json` 增加仓库与规则集条目，或在资源库页「＋ 新建」。
- **新增模板**：`gateway/seed/templates/*.ini`，头部 `; @title/@description/@targets` 会被解析。
- **远程引擎**：设置页切换，或直接改 `settings.json`。
