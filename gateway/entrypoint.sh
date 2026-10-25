#!/bin/sh
# SubHub 容器入口：
# 1) 创建 /config 下的持久化子目录
# 2) 修正挂载目录属主（无需宿主机手动 chown）
# 3) 打印宿主机路径提示
# 4) 降权到 node 用户执行 CMD
set -e

CONFIG_DIR="${CONFIG_DIR:-/config}"
RULES_DIR="${RULES_DIR:-$CONFIG_DIR/rules}"
ICONS_DIR="${ICONS_DIR:-$CONFIG_DIR/icons}"
TEMPLATES_DIR="${TEMPLATES_DIR:-$CONFIG_DIR/templates}"
CACHE_DIR="${CACHE_DIR:-$CONFIG_DIR/cache}"
STATE_DIR="${STATE_DIR:-$CONFIG_DIR/state}"
CONFIG_HOST_ROOT="${CONFIG_HOST_ROOT:-}"

mkdir -p "$RULES_DIR" "$ICONS_DIR" "$TEMPLATES_DIR" "$CACHE_DIR" "$STATE_DIR"

# 容器通常以 root 启动；bind mount 的宿主机目录属主可能是 root，
# 因此每次都尝试把配置目录交给运行用户，失败时保持原样。
chown -R node:node "$CONFIG_DIR" 2>/dev/null || true

if [ -n "$CONFIG_HOST_ROOT" ]; then
  echo "[entrypoint] 配置根目录: $CONFIG_DIR -> 宿主机 $CONFIG_HOST_ROOT"
  echo "[entrypoint]   规则: $RULES_DIR -> $CONFIG_HOST_ROOT/rules"
  echo "[entrypoint]   图标: $ICONS_DIR -> $CONFIG_HOST_ROOT/icons"
  echo "[entrypoint]   模板: $TEMPLATES_DIR -> $CONFIG_HOST_ROOT/templates"
  echo "[entrypoint]   缓存: $CACHE_DIR -> $CONFIG_HOST_ROOT/cache"
  echo "[entrypoint]   状态: $STATE_DIR -> $CONFIG_HOST_ROOT/state"
else
  echo "[entrypoint] 配置根目录: $CONFIG_DIR"
fi

exec su-exec node "$@"


