import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createServer } from "node:http";
import { exec } from "node:child_process";
import { OAuth2Client } from "google-auth-library";
import { createOAuthClient, saveToken } from "../youtube/auth.js";
import { parse, stringify } from "yaml";

// ── HTML templates ──────────────────────────────────────────────
const SUCCESS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorization Complete</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card {
    background: white;
    border-radius: 16px;
    padding: 48px 40px;
    text-align: center;
    box-shadow: 0 20px 60px rgba(0,0,0,0.15);
    max-width: 420px;
    margin: 20px;
  }
  .icon { font-size: 64px; margin-bottom: 16px; }
  h1 { font-size: 24px; color: #1a1a2e; margin-bottom: 12px; }
  p { font-size: 15px; color: #666; line-height: 1.6; }
</style>
</head>
<body>
<div class="card">
  <div class="icon">&#x2705;</div>
  <h1>Authorization Successful!</h1>
  <p>YouTube Drama has been connected.<br>You can safely close this tab.</p>
</div>
</body>
</html>`;

const ERROR_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorization Denied</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: linear-gradient(135deg, #f5576c 0%, #d63031 100%);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card {
    background: white;
    border-radius: 16px;
    padding: 48px 40px;
    text-align: center;
    box-shadow: 0 20px 60px rgba(0,0,0,0.15);
    max-width: 420px;
    margin: 20px;
  }
  .icon { font-size: 64px; margin-bottom: 16px; }
  h1 { font-size: 24px; color: #d63031; margin-bottom: 12px; }
  p { font-size: 15px; color: #666; line-height: 1.6; }
</style>
</head>
<body>
<div class="card">
  <div class="icon">&#x274C;</div>
  <h1>Authorization Denied</h1>
  <p>__ERROR_MESSAGE__<br>You can safely close this tab.</p>
</div>
</body>
</html>`;

// ── Constants ────────────────────────────────────────────────────
const CONFIG_DIR = join(homedir(), ".youtube-drama-mcp");
const TOKENS_DIR = join(CONFIG_DIR, "tokens");
const CONFIG_PATH = join(CONFIG_DIR, "channels.yaml");
const OAUTH_PORT = 8765;
const OAUTH_TIMEOUT_MS = 300_000; // 5 minutes
const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
];

// ── Helpers ──────────────────────────────────────────────────────
function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function tryOpenBrowser(url: string): boolean {
  try {
    const cmd =
      process.platform === "darwin"
        ? `open "${url}"`
        : process.platform === "win32"
          ? `start "" "${url}"`
          : `xdg-open "${url}"`;
    exec(cmd);
    return true;
  } catch {
    return false;
  }
}

/** Exchange OAuth code for token and save to disk. Shared by auto + manual flows. */
async function exchangeAndSaveToken(
  client: OAuth2Client,
  code: string,
  channelKey: string
): Promise<string> {
  const { tokens } = await client.getToken({
    code,
    redirect_uri: `http://localhost:${OAUTH_PORT}`,
  });
  client.setCredentials(tokens);

  const tokenPath = join(TOKENS_DIR, `${channelKey}.json`);
  ensureDir(TOKENS_DIR);

  const secretPath = join(CONFIG_DIR, "client_secret.json");
  saveToken(tokenPath, client, SCOPES, secretPath);
  return tokenPath;
}

function startOAuthServer(
  client: OAuth2Client,
  onCode: (code: string) => void,
  onError: (err: Error) => void
): { authUrl: string } {
  // Generate auth URL once, reuse
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    redirect_uri: `http://localhost:${OAUTH_PORT}`,
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url!, `http://localhost:${OAUTH_PORT}`);
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");

    if (error) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(ERROR_HTML.replace("__ERROR_MESSAGE__", `Error: ${error}`));
      server.close();
      onError(new Error(`OAuth error: ${error}`));
      return;
    }

    if (code) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(SUCCESS_HTML);
      server.close();
      onCode(code);
      return;
    }

    // Favicon or other stray requests — silently ignore
    res.writeHead(404);
    res.end("");
  });

  // ── Timeout guard ──
  const timeout = setTimeout(() => {
    server.close();
    onError(
      new Error(
        `OAuth timed out after ${OAUTH_TIMEOUT_MS / 60_000} minutes. Please try again.`
      )
    );
  }, OAUTH_TIMEOUT_MS);

  // Clear timeout when server closes naturally
  server.on("close", () => clearTimeout(timeout));

  server.on("error", (err: any) => {
    clearTimeout(timeout);
    if (err.code === "EADDRINUSE") {
      onError(
        new Error(
          `Port ${OAUTH_PORT} is in use. Close other apps using this port and retry.`
        )
      );
    } else {
      onError(err);
    }
  });

  server.listen(OAUTH_PORT, () => {
    const opened = tryOpenBrowser(authUrl);
    if (!opened) {
      // Browser auto-open failed (common in MCP/headless context);
      // the caller will print the URL for the user to open manually.
    }
  });

  return { authUrl };
}

// ── Tool registration ────────────────────────────────────────────
export function registerSetup(server: McpServer): void {
  server.tool(
    "setup_check",
    "Check current setup status: which channels are configured, which tokens exist",
    {},
    async () => {
      const configExists = existsSync(CONFIG_PATH);
      const secretExists = existsSync(join(CONFIG_DIR, "client_secret.json"));
      const tokensExist = existsSync(TOKENS_DIR)
        ? readdirSync(TOKENS_DIR).filter((f) => f.endsWith(".json"))
        : [];

      let channels: string[] = [];
      if (configExists) {
        const raw = parse(readFileSync(CONFIG_PATH, "utf-8"));
        channels = Object.keys(raw.channels || {});
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                configDir: CONFIG_DIR,
                clientSecretExists: secretExists,
                configExists,
                channels,
                tokenFiles: tokensExist,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "setup_init",
    "Initialize setup: guide user to create GCP project and provide client_secret.json",
    {
      channelKey: z.string().describe("Channel key name, e.g. my-channel"),
      channelId: z.string().describe("YouTube channel ID, starts with UC"),
    },
    async ({ channelKey, channelId }) => {
      ensureDir(CONFIG_DIR);
      ensureDir(TOKENS_DIR);

      const secretPath = join(CONFIG_DIR, "client_secret.json");
      if (!existsSync(secretPath)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "need_client_secret",
                  message:
                    "Please complete the following steps:\n\n" +
                    "1. Go to https://console.cloud.google.com/\n" +
                    "2. Create a new project (or select existing)\n" +
                    "3. Go to 'APIs & Services' → 'Library'\n" +
                    "   - Enable: YouTube Data API v3\n" +
                    "   - Enable: YouTube Analytics API\n" +
                    "4. Go to 'APIs & Services' → 'Credentials'\n" +
                    "5. Click '+ Create Credentials' → 'OAuth client ID'\n" +
                    "6. If prompted, configure OAuth consent screen first:\n" +
                    "   - User Type: External\n" +
                    "   - App name: anything\n" +
                    "   - Save\n" +
                    `7. Application type: Web application\n` +
                    `8. Authorized redirect URIs: add http://localhost:${OAUTH_PORT}\n` +
                    "9. Click Create → Download JSON\n" +
                    "10. Rename to client_secret.json\n" +
                    `11. Place it at: ${secretPath}\n\n` +
                    "After placing the file, call setup_authorize to continue.",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      // Update or create channel config
      let existing: any = { channels: {} };
      if (existsSync(CONFIG_PATH)) {
        existing = parse(readFileSync(CONFIG_PATH, "utf-8"));
      }
      existing.channels[channelKey] = {
        channel_id: channelId,
        token_file: join(TOKENS_DIR, `${channelKey}.json`),
        client_secret: secretPath,
        daily_quota_limit: 10000,
      };
      writeFileSync(CONFIG_PATH, stringify(existing), "utf-8");

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status: "config_written",
                channelKey,
                channelId,
                configPath: CONFIG_PATH,
                message:
                  "Channel config saved. Now call setup_authorize to log in with Google.",
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "setup_authorize",
    "Start OAuth authorization: launches a local server, opens your browser, and saves the token automatically when you approve",
    {
      channelKey: z.string().describe("Channel key from setup_init"),
    },
    async ({ channelKey }) => {
      const secretPath = join(CONFIG_DIR, "client_secret.json");
      if (!existsSync(secretPath)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "client_secret.json not found. Run setup_init first.",
            },
          ],
        };
      }

      const client = createOAuthClient(secretPath);

      return new Promise((resolve) => {
        const { authUrl } = startOAuthServer(
          client,
          // onCode — OAuth callback received
          async (code: string) => {
            try {
              const tokenPath = await exchangeAndSaveToken(
                client,
                code,
                channelKey
              );
              resolve({
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify(
                      {
                        status: "complete",
                        channelKey,
                        tokenPath,
                        message:
                          "Authorization complete! Token saved. You can now use all tools.",
                      },
                      null,
                      2
                    ),
                  },
                ],
              });
            } catch (err: any) {
              resolve({
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify(
                      { status: "error", error: err.message },
                      null,
                      2
                    ),
                  },
                ],
              });
            }
          },
          // onError
          (err: Error) => {
            resolve({
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    { status: "error", error: err.message },
                    null,
                    2
                  ),
                },
              ],
            });
          }
        );

        // Print URL to stderr as fallback (visible in MCP server logs)
        console.error(
          `\n\x1b[36m\x1b[1m🔐 YouTube OAuth\x1b[0m\n` +
            `If your browser didn't open, visit:\n\x1b[33m${authUrl}\x1b[0m\n`
        );
      });
    }
  );

  server.tool(
    "setup_complete",
    "Complete OAuth flow manually by pasting the authorization code from your browser's redirect URL",
    {
      channelKey: z.string().describe("Channel key from setup_init"),
      code: z
        .string()
        .describe(
          "Authorization code from browser redirect URL (the code=... parameter)"
        ),
    },
    async ({ channelKey, code }) => {
      const secretPath = join(CONFIG_DIR, "client_secret.json");
      if (!existsSync(secretPath)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "client_secret.json not found. Run setup_init first.",
            },
          ],
        };
      }

      const client = createOAuthClient(secretPath);

      try {
        const tokenPath = await exchangeAndSaveToken(client, code, channelKey);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "complete",
                  channelKey,
                  tokenPath,
                  message:
                    "Authorization complete! Token saved. You can now use all tools.",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                { status: "error", error: err.message },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );
}
