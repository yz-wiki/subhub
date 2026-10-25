# 部署手册

本文覆盖 Docker Compose、手动 `docker run`、反向代理、升级与回滚。

## 1. 前置条件

- Docker 24+，Docker Compose v2（`docker compose`）
- 一个可访问的 subconverter 引擎（完整 compose 会自动启动）
- 至少 1GB 内存；前端构建阶段建议 2GB 以上

## 2. Docker Compose 部署

### 2.1 完整链路（推荐）

```bash
git clone https://github.com/<your-name>/subhub.git
cd subhub
cp .env.example .env
# 编辑 .env，至少设置 PUBLIC_BASE 与 ADMIN_KEY
docker compose -f docker-compose.full.yml up -d --build
```

查看状态与日志：

```bash
docker compose -f docker-compose.full.yml ps
docker compose -f docker-compose.full.yml logs -f gateway
```

### 2.2 单服务模式

仅运行网关，转换引擎使用外部已有服务：

```bash
cd subhub
cp .env.example .env
# 把 SUBCONVERTER 改成外部引擎地址，例如 http://10.0.0.5:25500
docker compose up -d --build
```

单服务模式默认通过 `host.docker.internal:25500` 访问宿主机上的引擎（Linux 由 `extra_hosts: host-gateway` 支持）。如果引擎在另一台机器，把 `SUBCONVERTER` 改成对应地址即可。

### 2.3 目录说明

Compose 会自动创建：

```text
data/
├── rules/
├── icons/
├── templates/
├── cache/
├── state/
└── subconverter/     # 仅完整链路
```

五个 `/config` 子目录都是独立 bind mount，可直接通过 SFTP 查看和增删。首次启动会写入示例文件，日志会打印宿主机路径。

## 3. 手动 docker run

先构建镜像：

```bash
git clone https://github.com/<your-name>/subhub.git
cd subhub
docker build -f gateway/Dockerfile -t subhub/subhub:latest .
```

准备目录：

```bash
mkdir -p data/rules data/icons data/templates data/cache data/state
```

运行网关（引擎地址按实际修改）：

```bash
docker run -d --name subhub \
  --restart unless-stopped \
  -p 8080:8080 \
  -e TZ=Asia/Shanghai \
  -e PORT=8080 \
  -e CONFIG_DIR=/config \
  -e CONFIG_HOST_ROOT=./data \
  -e SUBCONVERTER=http://10.0.0.5:25500 \
  -e SELF_URL=http://10.0.0.10:8080 \
  -e PUBLIC_BASE=http://10.0.0.10:8080 \
  -e ADMIN_KEY=replace-with-random-hex \
  -v "$PWD/data/rules:/config/rules" \
  -v "$PWD/data/icons:/config/icons" \
  -v "$PWD/data/templates:/config/templates" \
  -v "$PWD/data/cache:/config/cache" \
  -v "$PWD/data/state:/config/state" \
  subhub/subhub:latest
```

单独运行 subconverter（可选，若没有现成引擎）：

```bash
docker run -d --name subconverter \
  --restart unless-stopped \
  --network subhub \
  -v "$PWD/data/subconverter:/base/cache" \
  asdlokj1qpi23/subconverter:latest
```

然后创建网络并把网关接进去：

```bash
docker network create subhub
```

## 4. 反向代理

### 4.1 Nginx（根路径）

```nginx
server {
    listen 443 ssl http2;
    server_name sub.example.com;

    client_max_body_size 16m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 180s;
    }
}
```

同时设置：

```env
PUBLIC_BASE=https://sub.example.com
TRUST_PROXY=true
```

### 4.2 Nginx（子路径）

```nginx
location /subhub/ {
    proxy_pass http://127.0.0.1:8080/;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Prefix /subhub;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

或网关自身处理前缀：

```env
SUBHUB_BASE_PATH=/subhub
PUBLIC_BASE=https://example.com/subhub
```

此时 `proxy_pass` 不要带末尾斜杠，让网关自己剥前缀。

### 4.3 Caddy

```caddyfile
sub.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

## 5. 升级

```bash
cd subhub
git pull
docker compose -f docker-compose.full.yml up -d --build
```

只更新镜像（使用 CI 推送的镜像）：

```bash
docker compose -f docker-compose.full.yml pull
docker compose -f docker-compose.full.yml up -d
```

升级前建议备份：

```bash
tar czf subhub-data-$(date +%F).tar.gz data/
```

## 6. 回滚

### 6.1 回滚镜像 tag

```bash
# .env 中固定版本
SUBHUB_IMAGE=subhub/subhub:v1.0.0

docker compose -f docker-compose.full.yml pull
docker compose -f docker-compose.full.yml up -d
```

### 6.2 回滚代码

```bash
git log --oneline -5
git checkout <previous-commit>
docker compose -f docker-compose.full.yml up -d --build
```

### 6.3 回滚数据

```bash
docker compose -f docker-compose.full.yml down
rm -rf data
tar xzf subhub-data-2026-01-01.tar.gz
docker compose -f docker-compose.full.yml up -d
```

> `data/` 内包含账户数据库 `subhub.db`、模板、规则集，回滚前确认已停止容器。

## 7. 健康检查

```bash
curl -fsS http://127.0.0.1:8080/api/health
```

返回 `"ok": true` 且 `engine.ok` 为 `true` 表示网关与转换引擎都正常。容器自身也配置了 healthcheck。


