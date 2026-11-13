// npm run mcp-check -- [--market PEPE --side long --margin 20 --leverage 1] [--coin <account>] [--rpc <url>]
//
// Starts the read-only MCP server (src/cli/mcp.ts) the way an MCP client does, over stdio, with the SDK's own client:
// lists the tools, then calls intern_status and intern_quote. Every tool only reads. The server gets only the SDK's
// default environment (HOME, LOGNAME, PATH, SHELL, TERM, USER), so nothing secret in this shell reaches it.
// Exit code: 0 both calls answered; 1 a tool answered with an error; 2 the server could not be reached.
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = fileURLToPath(new URL("./mcp.ts", import.meta.url));

const { values } = parseArgs({
  options: {
    market: { type: "string", default: "PEPE" },
    side: { type: "string", default: "long" },
    margin: { type: "string", default: "20" },
    leverage: { type: "string", default: "1" },
    coin: { type: "string" },
    rpc: { type: "string" },
  },
});
const pass = [
  ...(values.coin === undefined ? [] : ["--coin", values.coin]),
  ...(values.rpc === undefined ? [] : ["--rpc", values.rpc]),
];

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER, ...pass],
  stderr: "inherit",
});
const client = new Client({ name: "intern-mcp-check", version: "0.1.0" });
try {
  await client.connect(transport);
} catch (e) {
  console.error(`mcp-check: the server did not answer: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}

const server = client.getServerVersion();
console.log(
  `server: ${server?.name} ${server?.version}, over stdio (${process.execPath} ${SERVER} ${pass.join(" ")})`,
);
const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`);
for (const t of tools) {
  const hints = Object.entries(t.annotations ?? {})
    .filter(([k]) => k.endsWith("Hint"))
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  console.log(`  ${t.name}: ${t.title} [${hints}]`);
}

let errors = 0;
const calls: { name: string; arguments: Record<string, unknown> }[] = [
  { name: "intern_status", arguments: {} },
  {
    name: "intern_quote",
    arguments: {
      market: values.market,
      side: values.side,
      margin_usd: values.margin,
      leverage: Number(values.leverage),
    },
  },
];
for (const call of calls) {
  console.log(`\n=== ${call.name} ${JSON.stringify(call.arguments)}`);
  const r = await client.callTool(call);
  if (r.isError) errors++;
  const first = (r.content as { type: string; text?: string }[])[0];
  console.log(r.isError ? `ERROR: ${first?.text}` : first?.text);
}
await client.close();
process.exitCode = errors > 0 ? 1 : 0;
