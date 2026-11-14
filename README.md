# 一起看

轻量的双人同步观影网站：4 位房间码、音视频 MD5 秒传、同步播放、IM 和 WebRTC 语音。

## Docker 快速运行

安装 Docker 与 Docker Compose 后：

```bash
git clone https://github.com/qwe5283/yiqikan.git
cd yiqikan
docker compose up -d
```

打开 **http://localhost:3000**。在其他设备上访问时，将 `localhost` 换成运行 Docker 的主机地址。

- 修改端口：`APP_PORT=8080 docker compose up -d`
- 查看日志：`docker compose logs -f`
- 停止服务：`docker compose down`
- 上传的媒体直接保存在项目目录的 `./data`，重启、`down` 或 `down -v` 都不会删除这些宿主机文件。

**Linux 权限提醒：** 容器使用 UID 为 `1000` 的非 root `node` 用户。如果 `./data` 无法写入，请在项目目录执行以下命令后重新启动；Windows 和 macOS 通常无需此操作。

```bash
mkdir -p data
sudo chown -R 1000:1000 data
docker compose up -d
```

## 本地开发

需要 Node.js 18 或更高版本：

```bash
npm install
npm start
```

需要两个浏览器窗口（或两台设备）分别创建、加入房间。

- 房间和消息保存在内存中，所有成员离开后房间自动解散。
- 媒体按 MD5 全局去重，重启后仍可秒传。
- 单个文件最大 1 GB；实际可播放格式取决于浏览器解码能力，推荐 MP4、WebM、MP3、M4A。
- 语音需要麦克风权限，公网部署应使用 HTTPS。内置公共 STUN；复杂 NAT 或跨运营商网络需要自行配置 TURN 服务。

## 检查

```bash
npm test
node --check server.js
node --check public/app.js
docker compose config --quiet
```

## 许可证

[MIT](LICENSE)
