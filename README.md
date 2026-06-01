# YouTube Drama MCP

基于 Model Context Protocol (MCP) 的 YouTube 短剧分发流水线，让 AI 助手能够一站式完成短剧视频的下载、人声分离、合成与上传。

## 它是什么

YouTube Drama MCP 是一个 MCP Server，专门为中国短剧的 YouTube 分发场景设计。它将整个视频处理和上传流程封装为一组 MCP 工具，AI 助手（如 Claude、WorkBuddy 等）可以直接调用这些工具，自动完成从原始视频到 YouTube 发布的全流程。

**核心能力：**

- 从 URL 批量下载短剧视频
- 使用 Demucs AI 模型分离人声与背景音乐，去除原片 BGM
- 将纯净人声与视频画面合并
- 拼接多集为一整条视频（可选片头/片尾）
- 上传到 YouTube，支持设置标题、描述、标签和隐私状态
- 修改视频封面（缩略图）
- 将视频设为公开
- 查询频道数据分析（播放量、收入等）
- 监控 YouTube API 配额使用情况
- 自动化 OAuth 授权：一键发起 Google 登录，自动打开浏览器、接收回调、保存 Token，全程无需手动复制粘贴
- 多频道管理：支持在配置文件中定义多个 YouTube 频道，上传时按需切换
- 配额安全守卫：上传前自动检查 API 配额余量，配额不足时提前拦截，避免浪费操作

## 为什么需要它

短剧出海是一个常见需求，但手动操作流程繁琐：

1. 需要从分发平台下载原始视频
2. 原片通常带有 BGM，直接上传到 YouTube 会触发版权问题
3. 需要用 AI 工具分离人声，去除 BGM
4. 需要将处理后的音视频重新合成
5. 多集短剧可能需要拼成一条长视频
6. 最后上传到 YouTube 并设置元数据

YouTube Drama MCP 将这些步骤全部自动化，AI 助手只需按流程调用工具即可完成。

## 系统要求

| 依赖              | 用途                   | 安装方式                         |
| ----------------- | ---------------------- | -------------------------------- |
| **Node.js** >= 18 | 运行 MCP Server        | [nodejs.org](https://nodejs.org) |
| **FFmpeg**        | 音视频提取、合并、拼接 | `brew install ffmpeg`            |
| **Demucs**        | AI 人声分离            | `pip install demucs`             |
| **curl**          | 下载视频文件           | macOS 自带                       |

## 安装

```bash
# 克隆项目
git clone <repo-url>
cd youtube-drama-mcp

# 安装依赖
npm install

# 编译 TypeScript
npm run build
```

## 配置

### 1. 获取 YouTube 频道 ID

频道 ID 是以 `UC` 开头的 24 位字符串，例如 `UC6yao038-eVeUWalE95Vf4Q`。

**获取方法（任选一种）：**

- 打开 YouTube（https://www.youtube.com/account_advanced），登录后，其中 `UC` 开头的就是频道 ID

### 2. 创建 GCP 项目并获取 OAuth 凭据文件（client_secret.json）

这是整个配置中最关键的一步。按照以下步骤操作：

**第一步：创建 GCP 项目**

1. 打开 [Google Cloud Console](https://console.cloud.google.com/)
2. 点击顶部的项目选择器 → **新建项目**
3. 输入项目名称（如 `youtube-drama-mcp`），点击 **创建**
4. 确保左上角已切换到刚创建的项目

**第二步：启用所需的 API**

5. 左侧菜单 → **APIs & Services** → **Library**
6. 搜索 **YouTube Data API v3**，点击进入后点 **Enable**
7. 返回 Library，搜索 **YouTube Analytics API**，点击进入后点 **Enable**

**第三步：创建 OAuth 客户端凭据**

17. 左侧菜单 → **APIs & Services** → **Credentials**
18. 点击顶部 **+ Create Credentials** → **OAuth client ID**
19. Application type 选择 **Web application**
20. Name 随意填写（如 `drama-mcp-client`）
21. **Authorized redirect URIs** 是最关键的配置：
    - 点击 **Add URI**
    - 填入 `http://localhost:8765`
    - **注意：必须是 `8765` 端口**，这是程序内置的 OAuth 回调端口，填错会导致授权失败
22. 点击 **Create**

**第四步：获取 JSON 凭据内容**

23. 创建成功后会弹出一个对话框，点击 **Download JSON**（或稍后在 Credentials 列表中点击下载图标）
24. 打开下载的 JSON 文件，复制其中的**全部内容**，直接发给 AI 助手即可
25. AI 助手会自动将内容保存到 `~/.youtube-drama-mcp/client_secret.json`，**无需你手动移动文件**

> **提示：** 你不需要手动重命名或移动文件，只需把下载的 JSON 内容贴给 AI 助手，它会帮你搞定。

### 3. 初始化配置 & OAuth 授权（AI 助手自动完成）

以上步骤完成后，只需告诉 AI 助手你的频道信息，它会自动调用 `setup_init` 和 `setup_authorize` 完成全部配置，无需你手动操作任何命令或工具。

对 AI 助手说：

> 初始化我的 YouTube 频道，频道标识用 "video"，频道 ID 是 UCxxxxxxxxxx

AI 助手会自动完成以下操作：

1. **初始化配置** — 调用 `setup_init`，在 `~/.youtube-drama-mcp/` 下生成 `channels.yaml` 配置文件
2. **保存凭据** — 如果你把 `client_secret.json` 内容贴给 AI 助手，它会自动写入 `~/.youtube-drama-mcp/client_secret.json`
3. **OAuth 授权** — 调用 `setup_authorize`，自动在本地 `8765` 端口启动 HTTP 服务器、打开浏览器跳转到 Google 登录页
4. 你在浏览器中登录并同意授权后，程序自动接收授权码、换取 Token 并保存到本地
5. 浏览器显示"Authorization Successful!"页面，可以关闭

> **注意：** 授权时 Google 可能提示"此应用未经验证"，这是正常的（因为你用的是自己的 GCP 项目）。点击 **Advanced** → **Go to xxx (unsafe)** 即可继续。

如果浏览器无法自动打开（比如在远程服务器环境），AI 助手会给你一个授权 URL，手动在浏览器中打开并授权后，把地址栏中 `code=` 后面的值告诉 AI 助手，它会调用 `setup_complete` 完成授权。

### 4. 在 MCP 客户端中注册

在 MCP 客户端配置中添加此服务器。以 WorkBuddy 为例，在 `~/.workbuddy/mcp.json` 中添加：

```json
{
  "mcpServers": {
    "youtube-drama": {
      "command": "node",
      "args": ["/path/to/youtube-drama-mcp/dist/index.js"]
    }
  }
}
```

### 配置速查

| 项目              | 值                                                                                     | 说明                             |
| ----------------- | -------------------------------------------------------------------------------------- | -------------------------------- |
| OAuth 回调端口    | `8765`                                                                                 | 程序内置，不可更改               |
| 凭据文件路径      | `~/.youtube-drama-mcp/client_secret.json`                                              | 由 AI 助手自动创建，无需手动放置 |
| 频道配置文件      | `~/.youtube-drama-mcp/channels.yaml`                                                   | 自动生成                         |
| Token 存储目录    | `~/.youtube-drama-mcp/tokens/`                                                         | 每个频道一个 JSON                |
| OAuth 应用类型    | Web application                                                                        | 必须是此类型                     |
| 所需 API          | YouTube Data API v3, YouTube Analytics API                                             | 两个都必须启用                   |
| 所需 OAuth Scopes | `youtube.upload`, `youtube`, `yt-analytics.readonly`, `yt-analytics-monetary.readonly` | 程序自动请求，无需手动配置       |

## 工具一览

### 视频处理流水线

| 工具                  | 说明                             | 耗时            |
| --------------------- | -------------------------------- | --------------- |
| `download_episodes`   | 从 URL 下载视频到本地            | 取决于文件大小  |
| `separate_vocals`     | 启动 Demucs 人声分离（后台运行） | 每集约 2-5 分钟 |
| `check_vocals_status` | 查询人声分离进度                 | 即时            |
| `build_video`         | 合并处理后的人声与视频，拼接多集 | 数秒            |
| `upload_video`        | 上传视频到 YouTube（后台运行）   | 取决于文件大小  |
| `check_upload_status` | 查询上传进度                     | 即时            |

### YouTube 管理

| 工具               | 说明                  |
| ------------------ | --------------------- |
| `set_public`       | 将视频设为公开        |
| `set_thumbnail`    | 设置视频封面          |
| `pull_analytics`   | 拉取频道数据分析      |
| `get_quota_status` | 查看 API 配额使用情况 |

### 初始化与授权

| 工具              | 说明                              |
| ----------------- | --------------------------------- |
| `setup_check`     | 检查配置状态                      |
| `setup_init`      | 初始化频道配置                    |
| `setup_authorize` | 启动 OAuth 授权（自动打开浏览器） |
| `setup_complete`  | 手动完成 OAuth 授权（粘贴授权码） |

## 使用流程

### 典型工作流：从原始视频到 YouTube 发布

```
1. download_episodes     →  下载原始视频
2. separate_vocals       →  启动人声分离
3. check_vocals_status   →  轮询等待完成（每 30-60 秒查一次）
4. build_video           →  合成最终视频
5. upload_video          →  上传到 YouTube
6. check_upload_status   →  轮询等待上传完成
7. set_public            →  （可选）设为公开
```

### 示例对话

对 AI 助手说：

> 下载这个视频 https://example.com/drama.mp4，分离人声去掉BGM，然后上传到YouTube

AI 助手会自动按流程执行以上步骤。

## 数据目录结构

所有数据存储在 `~/.youtube-drama-mcp/` 下：

```
~/.youtube-drama-mcp/
├── channels.yaml                  # 频道配置
├── client_secret.json             # OAuth 凭据
├── tokens/                        # OAuth token 文件
│   └── video.json
├── quota/                         # API 配额记录
│   └── video.json
└── content/                       # 视频内容
    └── {dramaId}/
        ├── raw/                   # 原始下载视频
        │   └── episode_1.mp4
        ├── processed/             # 人声分离后的视频
        │   ├── episode_1_processed.mp4
        │   └── _tmp/             # 中间文件（Demucs 输出等）
        └── output/               # 最终合成视频
            └── {dramaId}-final.mp4
```

## API 配额说明

YouTube Data API v3 有每日配额限制（默认 10,000 单位）。主要操作的配额消耗：

| 操作          | 配额消耗 |
| ------------- | -------- |
| 上传视频      | 1,600    |
| 设置封面      | 50       |
| 设为公开      | 50       |
| 频道/视频列表 | 1        |
| 数据分析查询  | 1        |

每次上传消耗 1,600 单位，因此每天最多可上传约 6 个视频。配额在太平洋时间午夜重置。

项目内置了配额追踪系统，上传前会自动检查剩余配额是否充足。

## 多频道支持

`channels.yaml` 支持配置多个频道：

```yaml
channels:
  video:
    channel_id: "UCxxxxxxxxxx"
    token_file: ~/.youtube-drama-mcp/tokens/video.json
    client_secret: ~/.youtube-drama-mcp/client_secret.json
    daily_quota_limit: 10000
  shorts:
    channel_id: "UCyyyyyyyyyy"
    token_file: ~/.youtube-drama-mcp/tokens/shorts.json
    client_secret: ~/.youtube-drama-mcp/client_secret.json
    daily_quota_limit: 10000
```

上传时通过 `channelKey` 参数指定目标频道。

## 技术实现

- **MCP 协议**：使用 `@modelcontextprotocol/sdk` 实现，通过 stdio 传输
- **人声分离**：调用 [Demucs](https://github.com/facebookresearch/demucs)（Meta 开源的 AI 音源分离模型），使用 `htdemucs` 模型提取人声
- **音视频处理**：FFmpeg 提取音频、合并人声与视频、拼接多集
- **YouTube API**：通过 `googleapis` Node.js 客户端调用 YouTube Data API v3 和 YouTube Analytics API
- **OAuth 认证**：本地启动 HTTP 服务器接收回调，自动完成授权流程
- **后台任务**：人声分离和视频上传均以独立进程在后台运行，通过状态文件追踪进度
- **配额管理**：按太平洋时间自动按日重置，上传前检查配额余量

## 许可证

MIT
