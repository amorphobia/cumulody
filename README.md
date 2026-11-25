# Cumulody

Cumulody 让 Subsonic 播放器通过 Cloudflare Worker 读取个人 115 音乐目录。当前版本用于验证一件事：同一份原文件能否从你的账号经 Worker 连续播放，并在拖动进度条时从正确的字节位置继续。

## 本地试跑

使用 Node.js 22.13+（推荐 24 LTS）。在 115 网页中打开一个包含几首音乐的测试文件夹，记下地址中的 `cid`。选择具体的子目录，根目录 `0` 不受支持。第一次可选一首小于 200 MB 的 MP3、FLAC 或 M4A。

在仓库根目录运行以下 PowerShell 命令：

```powershell
Copy-Item .dev.vars.example .dev.vars
notepad .dev.vars
```

| 配置项 | 填写内容 |
| --- | --- |
| `DRIVE115_COOKIE` | 自己登录 115 网页后的 Cookie 请求头值。可从浏览器开发者工具的 Network 面板中，选择发往 `webapi.115.com` 的目录请求查看。仅复制值，保留分号，不含 `Cookie:`。 |
| `DRIVE115_ROOT_CID` | 测试音乐目录的数字 CID，按字符串填写。 |
| `SUBSONIC_USER` | 自定义的 Cumulody 播放器用户名。 |
| `SUBSONIC_PASSWORD` | 为这个播放器账号单独设置的密码。 |

保留模板里的引号。真实值只放入本地 `.dev.vars` 或 Cloudflare Worker Secrets，`.gitignore` 已排除本地配置。

```powershell
npm test
npx wrangler@4 dev
```

保持 Worker 运行，在同一目录另开一个终端：

```powershell
npm run probe
```

探针使用播放器凭据登录，从音乐目录找到一首歌，分别读取文件开头和中段的一个字节。两次都显示 `HTTP 206`，且 `Content-Range` 的位置和文件总大小均匹配，即通过。要重复验证特定曲目，可使用探针输出的歌曲 ID：

```powershell
npm run probe -- http://127.0.0.1:8787 s-123456789
```

## 部署到 Cloudflare Workers

在仓库根目录运行：

```powershell
npx wrangler@4 login
npx wrangler@4 deploy
npx wrangler@4 secret put DRIVE115_COOKIE
npx wrangler@4 secret put DRIVE115_ROOT_CID
npx wrangler@4 secret put SUBSONIC_USER
npx wrangler@4 secret put SUBSONIC_PASSWORD
```

每条 `secret put` 命令会提示输入对应的值。播放器凭据配置完成后，把部署输出的 Worker 地址传给探针。将示例 URL 换成实际地址：

```powershell
npm run probe -- https://cumulody.example.workers.dev
```

本地和云端各测一次，可以区分本机能取链但 Worker 出口无法播放的情况。轮换 Cookie 时重新执行 `npx wrangler@4 secret put DRIVE115_COOKIE` 即可。

如果同一首歌在本地可以播放、在云端取播放地址时失败，用下面的命令对照两端的配置。把地址和歌曲 ID 换成自己的。命令可直接在有 `.dev.vars` 的仓库目录运行，无需启动本地 Worker。

```powershell
npm run probe -- https://cumulody.example.workers.dev s-123456789 --compare-local
```

探针使用本地配置向 115 查询这首歌，再用一次性随机盐向已登录的云端接口校验 Cookie 和音乐取链请求。已有的同名环境变量优先于 `.dev.vars`。两行均为 `MATCH` 表示两端的 Cookie、请求方法、URL（含曲目的 pickcode）和程序设置的请求头一致。Cookie 不同时，第二项显示 `SKIPPED`。探针随后照常测试云端字节流。输出中不会出现 Cookie、pickcode 或签名链接。该对照覆盖 Cumulody 构造的请求，平台在传输时附加的信息不在对照范围内。

## 已实现的接口

| 接口 | 行为 |
| --- | --- |
| `ping`、`getOpenSubsonicExtensions` | 验证播放器凭据、发现 `formPost` 扩展。扩展发现可公开访问。 |
| `getMusicFolders`、`getIndexes`、`getMusicDirectory` | 返回音乐库入口、根目录中的子目录和曲目，逐级浏览。目录列表从 115 分页读取。 |
| `getSong` | 按 115 文件 ID 查找当前目录，再验证它仍在配置的音乐目录内。文件在音乐目录内改名或移动后保留歌曲 ID。 |
| `stream` | 通过 115 网页音乐播放接口请求原文件，由 Worker 流式返回。支持 GET、HEAD 和字节 Range，上游返回 200、206 或 416 时保留对应状态。 |

端点路径为 `/rest/<方法名>`，也接受 `.view` 后缀。默认返回 XML，`f=json` 返回 JSON。播放器使用 Subsonic 的 `u/t/s` 盐化令牌，支持 GET 查询参数和 POST 表单。115 账号 Cookie 只发往固定的 115 API 主机。获取音频时只使用上游为该下载签发的临时票据。

播放时，Worker 先向 `/files/music` 请求原始音频。如果取不到可用的原文件流，再尝试原有的网页下载接口 `/files/download`。两个接口共用已配置的 115 Cookie。如果都失败，探针会分别显示音乐播放和文件下载失败的阶段。

**当前限制**：曲目标题取自文件名，专辑和艺术家标签、封面、D1 索引以及 Feishin 的完整曲库浏览属于后续工作。探针验证字节流，实际播放、暂停和切歌仍需在播放器中验证。后续凭据管理按「受保护的管理页更新 Cookie → 扫码连接」推进。

接口参考：[OpenSubsonic](https://opensubsonic.github.io/docs/opensubsonic-api/) · [115 网页接口的社区实现](https://github.com/ChenyangGao/p115client/blob/main/p115client/client.py) · [Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
