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

| 依赖 | 用途 | 安装方式 |
|------|------|----------|
| **Node.js** >= 18 | 运行 MCP Server | [nodejs.org](https://nodejs.org) |
| **FFmpeg** | 音视频提取、合并、拼接 | `brew install ffmpeg` |
| **Demucs** | AI 人声分离 | `pip install demucs` |
| **curl** | 下载视频文件 | macOS 自带 |

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

### 1. 创建 GCP 项目并获取 OAuth 凭据

1. 前往 [Google Cloud Console](https://console.cloud.google.com/)
2. 创建新项目（或选择已有项目）
3. 在 **APIs & Services → Library** 中启用：
   - YouTube Data API v3
   - YouTube Analytics API
4. 在 **APIs & Services → Credentials** 中创建 OAuth client ID：
   - 应用类型：Web application
   - 授权重定向 URI：添加 `http://localhost:8765`
5. 下载 JSON 凭据文件，重命名为 `client_secret.json`

### 2. 初始化配置

在 MCP 客户端（如 WorkBuddy）中调用 `setup_init` 工具：

```
channelKey: "video"          # 频道标识，自定义名称
channelId: "UCxxxxxxxxxx"    # 你的 YouTube 频道 ID
```

这会在 `~/.youtube-drama-mcp/` 下生成 `channels.yaml` 配置文件。

将 `client_secret.json` 放置到 `~/.youtube-drama-mcp/client_secret.json`。

### 3. OAuth 授权

调用 `setup_authorize` 工具，会自动打开浏览器进行 Google OAuth 授权。授权完成后，token 会自动保存。

如果浏览器无法自动打开，也可以手动复制授权码，使用 `setup_complete` 工具完成授权。

### 4. 在 MCP 客户端中注册

在 MCP 客户端配置中添加此服务器。以 WorkBuddy 为例，在 `~/.workbuddy/mcp.json` 中添加：

```json
{
  "mcpServers": {
    "youtube-drama-v16": {
      "command": "node",
      "args": ["/path/to/youtube-drama-mcp/dist/index.js"]
    }
  }
}
```

## 工具一览

### 视频处理流水线

| 工具 | 说明 | 耗时 |
|------|------|------|
| `download_episodes` | 从 URL 下载视频到本地 | 取决于文件大小 |
| `separate_vocals` | 启动 Demucs 人声分离（后台运行） | 每集约 2-5 分钟 |
| `check_vocals_status` | 查询人声分离进度 | 即时 |
| `build_video` | 合并处理后的人声与视频，拼接多集 | 数秒 |
| `upload_video` | 上传视频到 YouTube（后台运行） | 取决于文件大小 |
| `check_upload_status` | 查询上传进度 | 即时 |

### YouTube 管理

| 工具 | 说明 |
|------|------|
| `set_public` | 将视频设为公开 |
| `set_thumbnail` | 设置视频封面 |
| `pull_analytics` | 拉取频道数据分析 |
| `get_quota_status` | 查看 API 配额使用情况 |

### 初始化与授权

| 工具 | 说明 |
|------|------|
| `setup_check` | 检查配置状态 |
| `setup_init` | 初始化频道配置 |
| `setup_authorize` | 启动 OAuth 授权（自动打开浏览器） |
| `setup_complete` | 手动完成 OAuth 授权（粘贴授权码） |

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

| 操作 | 配额消耗 |
|------|----------|
| 上传视频 | 1,600 |
| 设置封面 | 50 |
| 设为公开 | 50 |
| 频道/视频列表 | 1 |
| 数据分析查询 | 1 |

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

## 开发

```bash
# 开发模式（监听文件变化）
npm run dev

# 运行测试
npm test

# 编译
npm run build
```

## 许可证

MIT
