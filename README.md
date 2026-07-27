# SYNCWALL

这是可单独复制和部署的 SYNCWALL 源码目录。

本目录包含网页、后端接口、数据库结构、媒体存储适配和测试，不包含：

- `node_modules` 依赖目录
- 构建产物和缓存
- 本地数据库
- 已上传的视频、音频或图片
- 原站点的云端项目编号

## 最快启动

要求安装 Node.js `22.13.0` 或更高版本。

```bash
npm install
npm run dev
```

启动后：

- 控制端：`http://本机IP:3000/admin666`
- 被控端：`http://本机IP:3000/`

服务已监听 `0.0.0.0`，同一局域网内的电脑可以通过服务端电脑的局域网 IP 访问。

也可以直接运行：

- macOS：双击 `启动服务-macOS.command`
- Windows：双击 `启动服务-Windows.bat`

## 文档

- [完整使用教程](docs/使用教程.md)
- [故障排查](docs/故障排查.md)
- [文件与数据说明](docs/文件说明.md)

## 常用命令

```bash
npm run dev      # 启动局域网服务
npm run build    # 检查正式构建
npm test         # 运行自动化测试
npm run lint     # 检查源码
```
