import { OAuth2Client } from "google-auth-library";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

/** Ad Manager requires this scope. Read-only access is enforced by the user's GAM role, not the scope. */
const SCOPE = "https://www.googleapis.com/auth/admanager";

/**
 * OAuth client for a *desktop* app. Google treats desktop client secrets as
 * non-confidential (they ship inside distributed binaries), so these are safe
 * to bundle — the per-user refresh token is the sensitive part, and that never
 * leaves the machine it was created on.
 */
const CLIENT_ID = process.env.GAM_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GAM_OAUTH_CLIENT_SECRET;

/** Where the per-user refresh token is cached. Never leaves this machine. */
function tokenPath(): string {
  const home = homedir();
  if (platform() === "win32") {
    return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "bizclik-gam-mcp", "token.json");
  }
  if (platform() === "darwin") {
    return join(home, "Library", "Application Support", "bizclik-gam-mcp", "token.json");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "bizclik-gam-mcp", "token.json");
}

function openBrowser(url: string): void {
  const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  const bin = platform() === "win32" ? "cmd" : cmd;
  try {
    spawn(bin, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Non-fatal: the URL is printed to stderr as a fallback.
  }
}

function newClient(redirectUri?: string): OAuth2Client {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      "GAM_OAUTH_CLIENT_ID and GAM_OAUTH_CLIENT_SECRET must be set. " +
        "Create an OAuth client of type 'Desktop app' in your Google Cloud project.",
    );
  }
  return new OAuth2Client({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri });
}

/**
 * Runs the interactive consent flow: spins up a loopback listener, opens the
 * browser, waits for the redirect, then persists the refresh token.
 */
export async function authenticate(): Promise<OAuth2Client> {
  const { server, port } = await listen();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const client = newClient(redirectUri);

  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // force a refresh_token even on re-auth
    scope: [SCOPE],
  });

  process.stderr.write(`Opening browser for Google sign-in.\nIf it does not open, visit:\n${authUrl}\n`);
  openBrowser(authUrl);

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for Google sign-in (5 minutes).")), 300_000);
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", redirectUri);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get("error");
      const got = url.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body style="font-family:system-ui;padding:2rem">
        <h2>${err ? "Sign-in failed" : "Signed in"}</h2>
        <p>${err ? err : "You can close this tab and return to Claude."}</p>
      </body></html>`);
      clearTimeout(timer);
      err || !got ? reject(new Error(`Google sign-in failed: ${err ?? "no authorization code returned"}`)) : resolve(got);
    });
  }).finally(() => server.close());

  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const path = tokenPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  process.stderr.write(`Credentials saved to ${path}\n`);

  return client;
}

function listen(): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

/**
 * Returns a client backed by the cached refresh token, or null if this machine
 * has never been authenticated. Callers should surface a "run auth first"
 * message rather than launching a browser mid-tool-call.
 */
export async function loadCredentials(): Promise<OAuth2Client | null> {
  let raw: string;
  try {
    raw = await readFile(tokenPath(), "utf8");
  } catch {
    return null;
  }
  const client = newClient();
  client.setCredentials(JSON.parse(raw));
  return client;
}
