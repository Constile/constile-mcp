/** The MCP server's tools, as an assistant lists and calls them. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
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
  expect(await say("set_constile_preference", { policy: "decline" })).toContain("decline every ad");
  expect(await say("get_constile_preference", {})).toContain('"decline"');
  await client.close();
});

/** A publisher at pub.example whose pages carry an offer; `links` overrides where the offer's links point. Records every request. */
function publisher(links: Record<string, string> = {}) {
  const asked: string[] = [];
  const fetch = async (r: Request) => {
    asked.push(`${r.method} ${r.url}`);
    const u = new URL(r.url);
    if (u.pathname.startsWith("/articles/")) {
      return new Response("<p>SPONSORED ACCESS OFFER</p>", { headers: { "content-type": "text/html", "constile-offer": `https://pub.example/offer${u.pathname}` } });
    }
    if (u.pathname.startsWith("/offer/")) {
      const page = `https://pub.example${u.pathname.slice("/offer".length)}`;
      return Response.json({
        constile: "1", offer_version: "test", token: `tok${u.pathname.replace(/\W/g, "")}`, resource: { url: page, title: "A" },
        sponsored_message: "Sponsored: Tidegrind. https://constile.app/r/x", expires_at: 0, rules: [],
        actions: { defer: "https://pub.example/sponsored/deferred/t", prepared: "https://pub.example/sponsored/prepared/t", deliver_now: "https://pub.example/sponsored/delivered/t", content: "https://pub.example/sponsored/content/t", ...links },
      });
    }
    return new Response("<h1>The article</h1>", { headers: { "content-type": "text/html" } });
  };
  return { asked, fetch };
}

async function connect(fetch: (r: Request) => Promise<Response>, onElicit?: () => { action: "accept" | "decline"; content?: Record<string, unknown> }) {
  process.env.CONSTILE_PREFS ??= join(mkdtempSync(join(tmpdir(), "constile-mcp-")), "preferences.json");
  const { createServer, savePolicy } = await import("../src/server");
  savePolicy("ask");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(fetch).connect(serverSide);
  const client = new Client({ name: "test", version: "0" }, onElicit ? { capabilities: { elicitation: {} } } : {});
  if (onElicit) client.setRequestHandler(ElicitRequestSchema, async () => onElicit());
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: (r.content as { text: string }[])[0]!.text, isError: r.isError === true };
  };
  return { call, savePolicy, close: () => client.close() };
}

it("counts accept_sponsored only for an offer it showed for that page", async () => {
  const pub = publisher();
  const { call, close } = await connect(pub.fetch);
  const url = "https://pub.example/articles/first";
  // A yes before the person was asked is treated as no answer.
  expect((await call("read_article", { url, accept_sponsored: true })).text).toContain("Ask them before accepting");
  expect(pub.asked.filter((a) => a.startsWith("POST"))).toEqual([]);
  const accepted = await call("read_article", { url, accept_sponsored: true });
  expect(accepted.text).toContain("SPONSORED ACCESS ACCEPTED");
  expect(pub.asked).toContain("POST https://pub.example/sponsored/deferred/t");
  await close();
});

it("never requests the links of an offer that points off the page's site", async () => {
  const pub = publisher({ defer: "http://127.0.0.1:9/defer", deliver_now: "http://169.254.169.254/latest/meta-data" });
  const { call, savePolicy, close } = await connect(pub.fetch);
  // Saved as accept, so an offer that counted would be taken at once.
  savePolicy("accept");
  const read = await call("read_article", { url: "https://pub.example/articles/hostile" });
  expect(read.text).not.toMatch(/ACCESS ACCEPTED|Ask them/);
  expect(pub.asked.some((a) => /127\.0\.0\.1|169\.254/.test(a))).toBe(false);
  expect(pub.asked).toEqual(["GET https://pub.example/articles/hostile", "GET https://pub.example/offer/articles/hostile"]);
  await close();
});

it("refuses a shown_token from another page", async () => {
  const pub = publisher({ defer: undefined as unknown as string, prepared: undefined as unknown as string });
  const { call, close } = await connect(pub.fetch);
  const shown = await call("read_article", { url: "https://pub.example/articles/one" });
  const token = /shown_token set to "([^"]+)"/.exec(shown.text)?.[1];
  expect(token).toBeTruthy();
  const other = await call("read_article", { url: "https://pub.example/articles/two", shown_token: token });
  expect(other).toMatchObject({ isError: true });
  expect(pub.asked.some((a) => a.includes("/sponsored/delivered/"))).toBe(false);
  await close();
});

it("asks the person to confirm accepting automatically, where the client can ask", async () => {
  const no = await connect(publisher().fetch, () => ({ action: "decline" }));
  expect((await no.call("set_constile_preference", { policy: "accept" })).text).toContain("Not saved");
  expect((await no.call("get_constile_preference", {})).text).toContain('"ask"');
  await no.close();
  const yes = await connect(publisher().fetch, () => ({ action: "accept", content: { accept: true } }));
  expect((await yes.call("set_constile_preference", { policy: "accept" })).text).toContain("accept ads automatically");
  expect((await yes.call("get_constile_preference", {})).text).toContain('"accept"');
  await yes.close();
});
