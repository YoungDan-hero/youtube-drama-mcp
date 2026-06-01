import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { OAuth2Client } from "google-auth-library";

interface StoredToken {
  access_token: string;
  refresh_token: string;
  token_uri: string;
  client_id: string;
  client_secret: string;
  scopes: string[];
  expiry: string;
}

export function createOAuthClient(clientSecretPath: string): OAuth2Client {
  const raw = readFileSync(clientSecretPath, "utf-8");
  let secret: any;
  try {
    secret = JSON.parse(raw);
  } catch {
    throw new Error(
      `Client secret file corrupted: ${clientSecretPath}. Re-download from GCP console.`,
    );
  }
  if (!secret?.web?.client_id || !secret?.web?.client_secret) {
    throw new Error(
      `Invalid client secret format: ${clientSecretPath}. Expected { web: { client_id, client_secret } }.`,
    );
  }
  const { client_id, client_secret } = secret.web;

  return new OAuth2Client({
    clientId: client_id,
    clientSecret: client_secret,
    redirectUri: "http://localhost:8765",
  });
}

export function loadCredentials(
  tokenPath: string,
  clientSecretPath: string
): OAuth2Client {
  const client = createOAuthClient(clientSecretPath);

  if (!existsSync(tokenPath)) {
    throw new Error(
      `Token not found: ${tokenPath}. Run the OAuth flow first.`
    );
  }

  let stored: StoredToken;
  try {
    stored = JSON.parse(readFileSync(tokenPath, "utf-8"));
  } catch {
    throw new Error(
      `Token file corrupted: ${tokenPath}. Delete it and re-authorize via setup_authorize.`,
    );
  }
  if (!stored.access_token || !stored.refresh_token) {
    throw new Error(
      `Token file incomplete: ${tokenPath}. Missing access_token or refresh_token. Re-authorize.`,
    );
  }
  client.setCredentials({
    access_token: stored.access_token,
    refresh_token: stored.refresh_token,
    expiry_date: new Date(stored.expiry).getTime(),
  });

  client.on("tokens", (tokens) => {
    const updated: StoredToken = {
      access_token: tokens.access_token ?? stored.access_token,
      refresh_token: tokens.refresh_token ?? stored.refresh_token,
      token_uri: stored.token_uri,
      client_id: stored.client_id,
      client_secret: stored.client_secret,
      scopes: stored.scopes,
      expiry: tokens.expiry_date
        ? new Date(tokens.expiry_date).toISOString()
        : new Date().toISOString(),
    };
    writeFileSync(tokenPath, JSON.stringify(updated, null, 2), "utf-8");
  });

  return client;
}

export async function ensureValidToken(
  tokenPath: string,
  clientSecretPath: string
): Promise<OAuth2Client> {
  const client = loadCredentials(tokenPath, clientSecretPath);

  try {
    await client.getAccessToken();
  } catch (err: any) {
    if (err.message?.includes("invalid_grant")) {
      throw new Error(
        `Token expired and refresh failed for ${tokenPath}. Re-authorize.`
      );
    }
    throw err;
  }

  return client;
}

export function saveToken(
  tokenPath: string,
  client: OAuth2Client,
  scopes: string[],
  clientSecretPath: string
): void {
  const creds = client.credentials;
  let clientId = "";
  let clientSecret = "";

  if (clientSecretPath && existsSync(clientSecretPath)) {
    try {
      const raw = JSON.parse(readFileSync(clientSecretPath, "utf-8"));
      const sec = raw.web;
      clientId = sec.client_id ?? "";
      clientSecret = sec.client_secret ?? "";
    } catch {
      // Client secret file unreadable — leave clientId/clientSecret as empty strings
    }
  }

  const stored: StoredToken = {
    access_token: creds.access_token!,
    refresh_token: creds.refresh_token!,
    token_uri: "https://oauth2.googleapis.com/token",
    client_id: clientId,
    client_secret: clientSecret,
    scopes,
    expiry: new Date(creds.expiry_date ?? Date.now()).toISOString(),
  };
  writeFileSync(tokenPath, JSON.stringify(stored, null, 2), "utf-8");
}
