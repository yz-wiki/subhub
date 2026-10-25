# SubHub

多客户端订阅转换网关：一份订阅，同时生成 mihomo / sing-box / Surge / Loon / Quantumult X / Stash / v2rayN 等客户端配置。

前端 Vue 3 + Naive UI，后端 Node.js 零运行时依赖，转换引擎使用 [subconverter](https://github.com/tindy2013/subconverter)。支持可视化模板、规则集管理、节点批量处理、账户配额、注册码与运行日志。

## 架构

```text
┌──────────────┐      HTTP       ┌──────────────────┐      HTTP       ┌───────────────┐
│  浏览器 /     │ ──────────────▶ │  SubHub Gateway   │ ──────────────▶ │  subconverter │
│  订阅客户端   │ ◀────────────── │  :8080            │ ◀────────────── │  :25500       │
└──────────────┘                 │                  │                 └───────────────┘
                                 │  /config 持久化   │
                                 │  rules/icons/     │
                                 │  templates/cache  │
│  state            │
                                 └──────────────────┘
```

- **Gateway**：Web UI、账户与配额、订阅 token、模板托管、规则集元数据、日志。
- **subconverter**：真正执行协议解析与配置渲染；网关把模板和节点源注册为临时地址交给它拉取。
- **/config**：唯一持久化根目录，拆成 `rules`、`icons`、`templates`、`cache`、`state` 五个子目录，可直接 SSH/SFTP 管理。

## 特性

- 多客户端输出：mihomo、sing-box、Surge、Loon、Quantumult X、Stash、daed、Surfboard、v2rayN。
- 可视化模板编辑：基础 / DNS / 策略组 / 规则，带语法校验和错误行定位。
- 规则集：官方目录搜索、远程 URL、本地上传（`.mrs` / `.srs` / `.yaml` / `.list`）、自动检查更新。
- 节点：订阅 / 节点链接 / 配置文件导入，按来源分组、协议着色、批量改名、去重、地区识别。
- 订阅管理：固定 token 链接、二维码、各客户端专属配置、配置预览。
- 账户：角色权限、每日转换/拉取配额、允许客户端、到期时间、注册码与兑换码。
- 部署：单服务或完整链路两种 compose；反代与子路径；手动触发的 GitHub Actions 镜像构建。

## 快速开始

```bash
git clone https://github.com/<your-name>/subhub.git && cd subhub
cp .env.example .env
docker compose -f docker-compose.full.yml up -d --build
```

打开 `http://<服务器IP>:8080`，首次启动会自动创建管理员 `admin / admin`，登录后请立刻修改密码。

> 只有外部已有 subconverter 时才用 `docker-compose.yml`（单服务模式）；否则用 `docker-compose.full.yml`。

## 目录结构

```text
.
├── gateway/                # Node.js 网关
│   ├── server.js
│   ├── lib/                # 存储、模板、规则、鉴权、日志
│   ├── public/             # 旧版静态页兜底
│   ├── seed/               # 首次启动写入 /config 的示例资源
│   ├── Dockerfile
│   └── entrypoint.sh
├── web/                    # Vue 3 前端
│   └── src/
├── docs/                   # 部署、配置、API 文档
├── tools/                  # 规则目录构建脚本
├── docker-compose.yml      # 单服务
├── docker-compose.full.yml # 网关 + subconverter
└── .github/workflows/      # 手动构建镜像
```

## 持久化

默认挂载到 `./data`：

| 宿主机 | 容器 | 用途 |
| --- | --- | --- |
| `./data/rules` | `/config/rules` | 规则集库、上传的规则文件 |
| `./data/icons` | `/config/icons` | 自定义图标 |
| `./data/templates` | `/config/templates` | 转换模板 `.ini` |
| `./data/cache` | `/config/cache` | 目录缓存、可随时清空 |
| `./data/state` | `/config/state` | 账号库、订阅、运行设置 |

首次启动时目录为空会写入示例模板、内置规则集与示例图标，并在日志打印宿主机路径。

完整说明见 [docs/CONFIG.md](docs/CONFIG.md)。

## 文档

- [部署手册](docs/DEPLOY.md)
- [配置与 /config 目录](docs/CONFIG.md)
- [HTTP API](docs/API.md)
- [架构说明](docs/ARCHITECTURE.md)

## 镜像构建

在 GitHub Actions 页面手动运行 **Build and push Docker image**：

- 输入 `tag`（默认 `latest`）
- 是否同时推送 `latest`
- 目标平台（默认 `linux/amd64,linux/arm64`）

需要仓库 Secrets：`DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN`。工作流不会在 push/tag 时自动触发。

## 许可

[MIT](LICENSE)


