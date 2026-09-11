import {
  LineItemServiceClient,
  NetworkServiceClient,
  OrderServiceClient,
  ReportServiceClient,
} from "@google-ads/admanager";
import type { OAuth2Client } from "google-auth-library";

/**
 * Ad Manager resource names are network-scoped: `networks/{networkCode}/...`.
 * The code is stable per GAM network, so it is configuration rather than an
 * argument the model should have to supply on every call.
 */
export function networkParent(networkCode?: string): string {
  const code = networkCode ?? process.env.GAM_NETWORK_CODE;
  if (!code) {
    throw new Error(
      "No Ad Manager network code. Set GAM_NETWORK_CODE, or call list_networks to find the code for your account.",
    );
  }
  return `networks/${code}`;
}

export interface Clients {
  reports: ReportServiceClient;
  networks: NetworkServiceClient;
  orders: OrderServiceClient;
  lineItems: LineItemServiceClient;
}

export function makeClients(auth: OAuth2Client): Clients {
  const opts = { authClient: auth as never };
  return {
    reports: new ReportServiceClient(opts),
    networks: new NetworkServiceClient(opts),
    orders: new OrderServiceClient(opts),
    lineItems: new LineItemServiceClient(opts),
  };
}

export interface ReportRows {
  rows: unknown[];
  rowCount: number;
  truncated: boolean;
}

/**
 * Runs a saved report and returns its rows.
 *
 * Ad Manager reporting is a long-running operation: `runReport` returns an LRO
 * that must complete before the result rows can be fetched. We block on it
 * rather than exposing start/fetch as two tools — a single call is far easier
 * for a model to use correctly, and reports in this account are expected to
 * finish well inside the timeout. If slow reports become common, split this.
 */
export async function runReport(
  clients: Clients,
  reportName: string,
  maxRows: number,
  timeoutMs: number,
): Promise<ReportRows> {
  const [operation] = await clients.reports.runReport({ name: reportName });

  const completed = await Promise.race([
    operation.promise(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `Report did not finish within ${Math.round(timeoutMs / 1000)}s. ` +
                `It may still be running in Ad Manager — try a narrower date range.`,
            ),
          ),
        timeoutMs,
      ),
    ),
  ]);

  const resultName = completed[0]?.reportResult;
  if (!resultName) {
    throw new Error("Ad Manager returned no report result. The report may have produced no data.");
  }

  // The promise form of fetchReportResultRows auto-paginates through the entire
  // result set, which for a wide report is more than the context can hold. The
  // async iterator lets us stop at maxRows instead.
  const rows: unknown[] = [];
  let truncated = false;
  for await (const row of clients.reports.fetchReportResultRowsAsync({ name: resultName })) {
    if (rows.length >= maxRows) {
      truncated = true;
      break;
    }
    rows.push(row);
  }

  return { rows, rowCount: rows.length, truncated };
}
