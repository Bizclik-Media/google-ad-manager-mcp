# google-ad-manager-mcp

Read-only MCP server for Google Ad Manager. Exposes GAM reporting and inventory
metadata to Claude Desktop for analytics.

**Read-only by design.** No tool in this server mutates anything. But that is a
property of the code, not of your account — enforce it at the credential layer
too by giving the authenticating user a read-only role in Ad Manager. With
per-user OAuth (below) each person automatically inherits whatever permissions
they already have in GAM.

> Google Ad Manager is **not** Google Ads. This server targets the
> [Ad Manager API (Beta)](https://developers.google.com/ad-manager/api/beta),
> the publisher-side ad serving product. Google's own `google-ads-mcp` is for
> the advertiser-side Google Ads API and does not work here.

## Tools

| Tool | Purpose |
|---|---|
| `list_networks` | List accessible GAM networks and their network codes |
| `list_reports` | List saved reports; returns the resource names `run_report` takes |
| `run_report` | Run a saved report and return its rows |
| `list_orders` | List orders, for context alongside report data |
| `list_line_items` | List line items, for context alongside report data |

Reporting in Ad Manager is asynchronous — `run_report` starts a long-running
operation, waits for it, then fetches rows. It blocks for up to 90 seconds; if a
report is slower than that, narrow the date range.

## Setup

### 1. Enable the API

Enable the **Google Ad Manager API** in a Google Cloud project.

### 2. Create an OAuth client

Create an OAuth 2.0 client of type **Desktop app**.

Google treats desktop client secrets as non-confidential, because they ship
inside distributed applications. That means they are safe to put in a user's
local config — it does **not** mean they are safe to commit. This repository is
public; a published client ID and secret would let anyone show a Google consent
screen carrying our name. It grants no access to data (users still have to
consent, and tokens are per-user) but it is a phishing vector. Keep both values
in each machine's environment.

The genuinely sensitive value is the per-user refresh token, which is created on
the user's machine and never leaves it.

### 3. Authenticate

```bash
npm install && npm run build
GAM_OAUTH_CLIENT_ID=... GAM_OAUTH_CLIENT_SECRET=... node dist/index.js auth
```

A browser opens for Google sign-in. The refresh token is written to:

- macOS — `~/Library/Application Support/bizclik-gam-mcp/token.json`
- Windows — `%APPDATA%\bizclik-gam-mcp\token.json`
- Linux — `~/.config/bizclik-gam-mcp/token.json`

## Claude Desktop

Add to `claude_desktop_config.json`:

- macOS — `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows — `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "google-ad-manager": {
      "command": "npx",
      "args": ["-y", "github:Bizclik-Media/google-ad-manager-mcp"],
      "env": {
        "GAM_OAUTH_CLIENT_ID": "...",
        "GAM_OAUTH_CLIENT_SECRET": "...",
        "GAM_NETWORK_CODE": "..."
      }
    }
  }
}
```

`GAM_NETWORK_CODE` is optional — without it, ask Claude to run `list_networks`
and pass the code per call.

Claude Desktop bundles a Node runtime, so users do not need Node, Python, or any
other runtime installed. There is no Claude Desktop build for Linux; develop and
test against Claude Code, then verify on macOS or Windows.

## Development

```bash
npm run typecheck
npm run build
```

Smoke-test the MCP protocol without Claude:

```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node dist/index.js
```

## Security

This repository is public. Two things must never be committed:

- **OAuth client ID and secret** — see above.
- **Network codes, report names, advertiser names, or real report output.**
  These describe our commercial structure. The network code is read from
  `GAM_NETWORK_CODE` for exactly this reason. The likeliest way this leaks is a
  test fixture captured from a live report — scrub before committing.

## Status

Structurally complete and verified against the MCP protocol, but **no call has
been made against a live Ad Manager account**. Field names come from the
`@google-ads/admanager` type definitions, not from observed responses. Expect to
adjust the response shaping in `src/index.ts` once real data is flowing.
