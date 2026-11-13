// npm run --silent mcp -- [--coin <account>] [--rpc <url>]     (or: node src/cli/mcp.ts [...])
//
// The Intern's read-only MCP server over stdio (src/mcp.ts): six tools for other AI agents. Every tool only reads
// (NEAR RPC views and transactions, Hyperliquid testnet's public /info); none signs, sends or spends anything. It
// reads no key, no .env and no environment variable: everything it needs is on its command line.
//   --coin <account>  The coin contract. Default: testnet.coin in intern/interface/deployments.json.
//   --rpc <url>       NEAR testnet RPC. Default: https://test.rpc.fastnear.com. The public archival nodes are the
//                     fallback when a node no longer has the data (src/near-rpc.ts).
// stdout carries the protocol only, so everything else goes to stderr. Plain `npm run mcp` prints npm's own
// banner on stdout first; an MCP client should start `node src/cli/mcp.ts` or `npm run --silent mcp`.
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { chainId, finalSnapshot, READ_RPC } from "../chain-snapshot.ts";
import { deployedTestnetCoin } from "../deployments.ts";
import { internMcpServer } from "../mcp.ts";
import { TESTNET_ARCHIVAL_RPCS } from "../near-rpc.ts";

// Nothing but the protocol may reach stdout: a stray log line from any module would break the client's stream.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

function fail(message: string): never {
  console.error(`mcp: ${message}`);
  process.exit(2);
}

const { values } = parseArgs({ options: { coin: { type: "string" }, rpc: { type: "string" } } });
const coin = values.coin ?? deployedTestnetCoin() ?? fail("no coin contract: pass --coin <account>");
const rpc = values.rpc ?? READ_RPC;
const urls = [rpc, ...TESTNET_ARCHIVAL_RPCS.filter((u) => u !== rpc)];

// Testnet only, checked once before the first read (and again after a failed check).
let testnet: Promise<void> | null = null;
function onTestnet(): Promise<void> {
  testnet ??= chainId([rpc], fetch).then(
    (id) => {
      if (id !== "testnet") throw new Error(`${rpc} is ${id}, not testnet; this server reads testnet only`);
    },
    (e: unknown) => {
      testnet = null;
      throw e;
    },
  );
  return testnet;
}

const server = internMcpServer({
  coin,
  rpc,
  snapshot: async () => {
    await onTestnet();
    return finalSnapshot(urls, coin, fetch);
  },
  fetchFn: fetch,
  verifyRpcs: urls,
  now: () => Date.now(),
});
await server.connect(new StdioServerTransport());
console.error(`mcp: the Intern's read-only MCP server is running on stdio (coin ${coin}, RPC ${rpc})`);
