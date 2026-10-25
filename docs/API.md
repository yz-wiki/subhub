# HTTP API

默认地址 `http://<host>:8080`。除 `/api/health`、订阅 `/s/:token`、临时链接 `/c/:payload`、模板 `/tpl/:name.ini` 外，接口都需要登录会话（Cookie）或 `ADMIN_KEY`。

请求与响应均为 JSON，错误格式：

```json
{ "error": "说明" }
```

## 1. 系统

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 网关与引擎健康状态 |
| GET | `/api/state` | 当前用户、模板、资源库、目标客户端等聚合状态 |
| GET | `/api/targets` | 支持的客户端列表 |
| GET | `/api/rules?q=&limit=` | 官方规则目录搜索 |
| GET/PUT | `/api/engine` | 查看 / 更新转换引擎地址 |
| GET | `/api/logs?cat=&q=&limit=` | 运行日志，普通用户仅返回自己的记录 |

健康检查示例：

```bash
curl -s http://127.0.0.1:8080/api/health
```

## 2. 认证

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` | `{ "username": "...", "password": "..." }` |
| POST | `/api/auth/logout` | 退出当前会话 |
| GET | `/api/auth/me` | 当前登录用户 |
| POST | `/api/auth/register` | 使用注册码注册 |
| POST | `/api/auth/password` | 修改自己的密码 |

```bash
curl -c cookies.txt -s http://127.0.0.1:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}'
```

## 3. 节点与转换

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/nodes/preview` | 解析订阅 / 节点链接 / 配置文件，返回节点列表 |
| POST | `/api/convert` | 生成指定客户端配置 |
| POST | `/api/link` | 生成临时转换链接 |

解析节点：

```bash
curl -b cookies.txt -s http://127.0.0.1:8080/api/nodes/preview \
  -H 'Content-Type: application/json' \
  -d '{"mode":"text","text":"ss://...\ntrojan://..."}'
```

转换：

```bash
curl -b cookies.txt -s http://127.0.0.1:8080/api/convert \
  -H 'Content-Type: application/json' \
  -d '{
    "target":"mihomo",
    "template":"full",
    "sources":["https://example.com/sub"],
    "include":"",
    "exclude":"",
    "opts":{}
  }'
```

## 4. 模板

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/templates` | 模板列表 |
| GET | `/api/templates/:name` | 读取模板原始内容 |
| POST | `/api/templates` | 新建 `{name, content}` |
| PUT | `/api/templates/:name` | 保存 `{content}` |
| DELETE | `/api/templates/:name` | 删除 |
| POST | `/api/templates/parse` | 解析 INI 为可视化模型 |
| POST | `/api/templates/build` | 由模型生成 INI，并返回 warnings / errors |
| POST | `/api/templates/preview` | 用模板跑一次真实转换 |

## 5. 固定订阅

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/profiles` | 订阅列表 |
| POST | `/api/profiles` | 新建订阅 |
| PUT | `/api/profiles/:token` | 更新订阅 |
| DELETE | `/api/profiles/:token` | 删除 |
| GET | `/s/:token` | 通用订阅入口 |
| GET | `/s/:token/:target` | 指定客户端订阅 |

## 6. 资源库

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/library` | 规则集、基础、DNS、仓库、分类、设置 |
| POST | `/api/library/rulesets` | 新建规则集 |
| PUT | `/api/library/rulesets/:id` | 更新 |
| DELETE | `/api/library/rulesets/:id` | 删除 |
| POST | `/api/library/rulesets/:id/check` | 检查远端更新 |
| GET/PUT | `/api/library/settings` | 自动更新全局设置 |
| GET/POST/PUT/DELETE | `/api/library/categories` | 分类管理 |
| POST | `/api/library/upload` | 上传本地规则文件（base64） |
| GET | `/api/library/file/:name` | 拉取已上传的规则文件 |

上传 `.mrs` / `.srs`：

```bash
curl -b cookies.txt -s http://127.0.0.1:8080/api/library/upload \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"adblock.mrs\",\"data\":\"$(base64 -w0 adblock.mrs)\"}"
```

返回：

```json
{ "ok": true, "url": "http://host:8080/api/library/file/xxxx-adblock.mrs", "size": 123456 }
```

## 7. 图标与日志

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/icons` | 内置 + 自定义图标 |
| POST | `/api/icons` | 新增 `{name, category, value}` |
| DELETE | `/api/icons/:id` | 删除自定义图标 |
| GET | `/api/logs` | 按 `cat`（system/network/convert/pull/auth）、`q`、`limit` 过滤 |
| GET | `/api/cache` | 缓存统计 |
| DELETE | `/api/cache` | 清空转换缓存 |

## 8. 账户与注册码

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/api/users` | 用户列表 / 新建 |
| PUT/DELETE | `/api/users/:id` | 修改 / 删除 |
| GET/POST | `/api/invites` | 注册码 / 兑换码 |
| DELETE | `/api/invites/:code` | 删除 |
| POST | `/api/invites/redeem` | 当前用户兑换额度 |

配额字段：

```json
{
  "quota": {
    "dailyConvert": 20,
    "dailyPull": 50,
    "maxProfiles": 5,
    "clients": ["mihomo", "sing-box"],
    "expiresAt": "2027-01-01T00:00:00.000Z"
  }
}
```

`0` 或空数组表示不限。

## 9. 状态码

| 状态码 | 含义 |
| --- | --- |
| 200 | 成功 |
| 400 | 参数错误 |
| 401 | 未登录或会话失效 |
| 403 | 权限不足 / 配额用尽 |
| 404 | 资源不存在 |
| 429 | 触发限流 |
| 502 | 转换引擎不可用或返回错误 |
