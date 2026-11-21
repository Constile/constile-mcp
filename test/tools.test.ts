/** The MCP server's tools, as an assistant lists and calls them. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";

it("names its tools for Constile, and saves and reads back the person's choice", async () => {
  process.env.CONSTILE_PREFS = join(mkdtempSync(join(tmpdir(), "constile-mcp-")), "preferences.json");
  const { createServer } = await import("../src/server");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  expect(names).toEqual(["get_constile_preference", "read_article", "report_sponsored_message", "set_constile_preference"].sort());
  const say = async (name: string, args: Record<string, unknown>) => ((await client.callTool({ name, arguments: args })).content as { text: string }[])[0]!.text;
  expect(await say("set_constile_preference", { policy: "decline" })).toContain("decline every offer");
  expect(await say("get_constile_preference", {})).toContain('"decline"');
  await client.close();
});
