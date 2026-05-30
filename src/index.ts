#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerDownloadEpisodes } from "./tools/download.js";
import { registerSeparateVocals } from "./tools/vocals.js";
import { registerBuildVideo } from "./tools/build.js";
import { registerUploadVideo, registerSetPublic } from "./tools/upload.js";
import { registerSetThumbnail } from "./tools/thumbnail.js";
import { registerPullAnalytics } from "./tools/analytics.js";
import { registerGetQuotaStatus } from "./tools/quota.js";
import { registerSetup } from "./tools/setup.js";

const server = new McpServer({
  name: "youtube-drama-mcp",
  version: "1.0.0",
});

registerDownloadEpisodes(server);
registerSeparateVocals(server);
registerBuildVideo(server);
registerUploadVideo(server);
registerSetPublic(server);
registerSetThumbnail(server);
registerPullAnalytics(server);
registerGetQuotaStatus(server);
registerSetup(server);

const transport = new StdioServerTransport();
await server.connect(transport);
