#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { authenticate, loadCredentials } from "./auth.js";
import { makeClients, networkParent, runReport, type Clients } from "./gam.js";

const REPORT_TIMEOUT_MS = 90_000;

/** Tool results are JSON text; keep payloads bounded so a wide report can't flood the context. */
function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

const NOT_AUTHED =
  "Not signed in to Google Ad Manager on this machine. Run `npx gam-mcp auth` in a terminal, " +
  "then retry — a browser window will open for Google sign-in.";

async function main() {
  if (process.argv[2] === "auth") {
    await authenticate();
    process.stderr.write("Authenticated. You can now use the Ad Manager tools in Claude.\n");
    return;
  }

  const server = new McpServer({ name: "gam-mcp", version: "0.1.0" });

  // Credentials are resolved lazily so the server still starts (and can report a
  // useful error) on a machine that has never been authenticated.
  let clients: Clients | null = null;
  async function getClients(): Promise<Clients | null> {
    if (clients) return clients;
    const auth = await loadCredentials();
    if (!auth) return null;
    clients = makeClients(auth);
    return clients;
  }

  server.registerTool(
    "list_networks",
    {
      title: "List Ad Manager networks",
      description:
        "List the Google Ad Manager networks this account can access, with their network codes. " +
        "Use this to discover the network code if it has not been configured.",
      inputSchema: {},
    },
    async () => {
      const c = await getClients();
      if (!c) return failure(NOT_AUTHED);
      const [networks] = await c.networks.listNetworks({});
      return json(
        networks.map((n) => ({ name: n.name, networkCode: n.networkCode, displayName: n.displayName, currencyCode: n.currencyCode })),
      );
    },
  );

  server.registerTool(
    "list_reports",
    {
      title: "List saved reports",
      description:
        "List saved reports in Ad Manager. Returns each report's resource name, which is what run_report takes. " +
        "Use this first to find the report to run.",
      inputSchema: {
        networkCode: z.string().optional().describe("Ad Manager network code. Defaults to the configured network."),
        pageSize: z.number().int().min(1).max(200).default(50).describe("Maximum reports to return."),
      },
    },
    async ({ networkCode, pageSize }) => {
      const c = await getClients();
      if (!c) return failure(NOT_AUTHED);
      const [reports] = await c.reports.listReports({ parent: networkParent(networkCode), pageSize });
      return json(
        reports.map((r) => ({
          name: r.name,
          reportId: r.reportId,
          displayName: r.displayName,
          visibility: r.visibility,
          locale: r.locale,
        })),
      );
    },
  );

  server.registerTool(
    "run_report",
    {
      title: "Run a saved report",
      description:
        "Run a saved Ad Manager report and return its rows. Takes the report resource name from list_reports " +
        "(e.g. 'networks/12345678/reports/42'). Reporting is asynchronous in Ad Manager; this waits for completion. " +
        "Read-only — it runs an existing report definition and never modifies it.",
      inputSchema: {
        reportName: z.string().describe("Report resource name, e.g. 'networks/12345678/reports/42'."),
        maxRows: z.number().int().min(1).max(5000).default(500).describe("Maximum rows to return."),
      },
    },
    async ({ reportName, maxRows }) => {
      const c = await getClients();
      if (!c) return failure(NOT_AUTHED);
      return json(await runReport(c, reportName, maxRows, REPORT_TIMEOUT_MS));
    },
  );

  server.registerTool(
    "list_orders",
    {
      title: "List orders",
      description: "List Ad Manager orders, for context alongside report data. Supports a filter expression.",
      inputSchema: {
        networkCode: z.string().optional().describe("Ad Manager network code. Defaults to the configured network."),
        filter: z.string().optional().describe("Ad Manager filter expression, e.g. 'status = APPROVED'."),
        pageSize: z.number().int().min(1).max(200).default(50).describe("Maximum orders to return."),
      },
    },
    async ({ networkCode, filter, pageSize }) => {
      const c = await getClients();
      if (!c) return failure(NOT_AUTHED);
      const [orders] = await c.orders.listOrders({ parent: networkParent(networkCode), filter, pageSize });
      return json(
        orders.map((o) => ({
          name: o.name,
          displayName: o.displayName,
          status: o.status,
          advertiser: o.advertiser,
          startTime: o.startTime,
          endTime: o.endTime,
        })),
      );
    },
  );

  server.registerTool(
    "list_line_items",
    {
      title: "List line items",
      description: "List Ad Manager line items, for context alongside report data. Supports a filter expression.",
      inputSchema: {
        networkCode: z.string().optional().describe("Ad Manager network code. Defaults to the configured network."),
        filter: z.string().optional().describe("Ad Manager filter expression, e.g. 'status = DELIVERING'."),
        pageSize: z.number().int().min(1).max(200).default(50).describe("Maximum line items to return."),
      },
    },
    async ({ networkCode, filter, pageSize }) => {
      const c = await getClients();
      if (!c) return failure(NOT_AUTHED);
      const [items] = await c.lineItems.listLineItems({ parent: networkParent(networkCode), filter, pageSize });
      return json(
        items.map((l) => ({
          name: l.name,
          displayName: l.displayName,
          status: l.status,
          lineItemType: l.lineItemType,
          startTime: l.startTime,
          endTime: l.endTime,
        })),
      );
    },
  );

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`gam-mcp failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
