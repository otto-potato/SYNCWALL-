#!/bin/sh

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请先安装 Node.js 22.13.0 或更高版本。"
  read -r _
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "首次启动，正在安装依赖……"
  npm ci || exit 1
fi

echo "正在启动 SYNCWALL 局域网服务……"
npm run dev

