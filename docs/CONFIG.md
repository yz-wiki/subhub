# 配置与 /config 目录手册

## 1. 环境变量

所有变量都可以写在 `.env`，Compose 会自动读取。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 容器内监听端口 |
| `GATEWAY_PORT` | `8080` | 宿主机映射端口（仅 compose） |
| `CONFIG_DIR` | `/config` | 持久化根目录 |
| `RULES_DIR` | `$CONFIG_DIR/rules` | 规则目录 |
| `ICONS_DIR` | `$CONFIG_DIR/icons` | 图标目录 |
| `TEMPLATES_DIR` | `$CONFIG_DIR/templates` | 模板目录 |
| `CACHE_DIR` | `$CONFIG_DIR/cache` | 缓存目录 |
| `CONFIG_HOST_ROOT` | 空 | 宿主机路径提示，仅用于日志 |
| `SUBCONVERTER` | `http://127.0.0.1:25500` | 转换引擎地址 |
| `SELF_URL` | `http://127.0.0.1:$PORT` | 引擎回源拉取模板/订阅的网关地址 |
| `PUBLIC_BASE` | 空 | 对外访问地址，用于生成订阅与二维码；留空按请求推断 |
| `SUBHUB_BASE_PATH` | 空 | 子路径部署前缀，例如 `/subhub` |
| `ADMIN_KEY` | 空 | 兜底管理密钥；留空则关闭该入口 |
| `CACHE_TTL` | `300` | 转换结果缓存秒数，`0` 为不缓存 |
| `ENGINE_TIMEOUT` | `120000` | 单次转换超时毫秒 |
| `ALLOW_PRIVATE_SOURCES` | `false` | 是否允许内网/回环订阅源（防 SSRF） |
| `TRUST_PROXY` | `false` | 是否信任 `X-Forwarded-For` |
| `RATE_CONVERT` | `30` | 匿名转换每分钟上限 |
| `RATE_SUBSCRIBE` | `120` | 匿名订阅每分钟上限 |
| `STATE_DIR` | `/config/state` | 账号库、订阅、运行设置 |
| `DATA_DIR` | 空 | 兼容旧版；`CONFIG_DIR` 未设置时作为回退 |

> `ADMIN_KEY` 只用于脚本调用写接口；网页端使用账号密码登录，不要把它当前端密码使用。

## 2. /config 目录

容器内统一以 `/config` 为持久化根，五个子目录分别挂载：

| 宿主机（默认） | 容器路径 | 用途 | 是否可热更新 |
| --- | --- | --- | --- |
| `./data/rules` | `/config/rules` | `library.json`（规则集库、分类、更新方式）、`uploads/`（本地上传的规则文件） | 通过 Web UI 修改即时生效；直接改文件需重启 |
| `./data/icons` | `/config/icons` | `icons.json`（自定义图标，base64 或 emoji） | 通过 Web UI 即时生效；直接改文件需重启 |
| `./data/templates` | `/config/templates` | 转换模板 `.ini`，文件名即模板名 | 通过 Web UI 保存即时生效；直接改文件需重启 |
| `./data/cache` | `/config/cache` | 官方规则目录缓存 `rules-catalog.json`；可随时清空 | 是（删除后自动重建） |
| `./data/state` | `/config/state` | `subhub.db`、`settings.json`、`profiles.json` | 否，修改后需重启 |

宿主机上还可能出现：

```text
data/
├── rules/
│   ├── library.json
│   └── uploads/
├── icons/
│   └── icons.json
├── templates/
│   ├── full.ini
│   ├── lite.ini
│   └── minimal.ini
├── cache/
│   └── rules-catalog.json
├── state/
│   ├── subhub.db      # SQLite：账号、注册码、配额、日志
│   ├── settings.json  # 引擎与运行设置
│   └── profiles.json  # 固定订阅
└── subconverter/      # 仅完整 compose：引擎缓存
```

### 2.1 首次启动

启动脚本会创建五个子目录（rules / icons / templates / cache / state）。若目录为空，服务会写入示例文件：

- `templates/*.ini`：完整分流 / 轻量 / 极简三套模板
- `rules/library.json`：内置规则集与更新策略
- `cache/rules-catalog.json`：官方规则目录缓存
- `icons/icons.json`：示例图标

启动日志会打印容器路径与宿主机路径，例如：

```text
[entrypoint] 配置根目录: /config -> 宿主机 ./data
[boot]  规则 = /config/rules（宿主机 ./data/rules）
```

### 2.2 通过 SFTP / SSH 管理

可以直接编辑宿主机目录，但要理解进程内缓存：

- **模板、规则、图标**：网关启动时读入内存；直接改文件后执行 `docker compose restart gateway`。
- **通过 Web UI 修改**：网关会原子写回文件并立即生效，无需重启。
- **cache**：纯缓存，删除不会丢配置。

### 2.3 备份与迁移

需要备份的最小集合：

```bash
tar czf subhub-backup.tar.gz \
  data/rules data/icons data/templates data/state
```

`data/subconverter` 与 `data/cache` 可以丢弃。

## 3. 转换引擎

- 完整链路：`SUBCONVERTER=http://subconverter:25500`，由 compose 自动设置。
- 单服务：默认 `http://host.docker.internal:25500`，指向宿主机；引擎在别处时改成实际地址。
- 引擎不可达时网关仍可启动，`/api/health` 会显示 `engine.ok=false`，转换请求报错。

## 4. 子路径部署

两种方式二选一：

1. 反向代理剥前缀并发送 `X-Forwarded-Prefix: /subhub`；
2. 保持完整路径并设置 `SUBHUB_BASE_PATH=/subhub`。

同时把 `PUBLIC_BASE` 设置为带前缀的完整地址，否则订阅链接会缺少前缀。





