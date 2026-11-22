/**
 * An MCP server with a read_article tool that handles Constile ads per the person's saved choice (default "ask":
 * the assistant asks first and can save the answer).
 *
 *   CONSTILE_PREFS  where the person's choice is saved
 *                           (default ~/.config/constile/preferences.json)
 *   CONSTILE_UA     the user agent to fetch with (default "ConstileMCP-User/0.1 (+https://constile.app)")
 *
 * The constile-mcp command (bin.ts) starts it over stdio.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type ConsentPolicy, type MachineOffer, type SponsoredResult, consentQuestion, sponsoredFetch } from "constile-agent-sdk";
import { z } from "zod";

const PREFS = process.env.CONSTILE_PREFS || join(homedir(), ".config", "constile", "preferences.json");
const UA = process.env.CONSTILE_UA || "ConstileMCP-User/0.1 (+https://constile.app)";
const MAX_TEXT = 60_000;

export function loadPolicy(): ConsentPolicy {
  try {
    const p = JSON.parse(readFileSync(PREFS, "utf8")).policy;
    return p === "accept" || p === "decline" ? p : "ask";
  } catch {
    return "ask";
  }
}

export function savePolicy(policy: ConsentPolicy) {
  mkdirSync(dirname(PREFS), { recursive: true });
  writeFileSync(PREFS, JSON.stringify({ policy, saved_at: new Date().toISOString() }, null, 2));
}

/** Readable text from an HTML page: drops scripts, styles, and tags. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/h[1-6]|\/li|\/div|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
}

const offers = new Map<string, MachineOffer>();
/** The page each offer this session put to the person was for. accept_sponsored and shown_token count only for these. */
const offeredPages = new Map<string, string>();
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

async function render(r: SponsoredResult): Promise<string> {
  if (r.kind === "declined") {
    return "This page carries a Constile ad, and the person has chosen to decline Constile ads. Answer without this page.";
  }
  if (r.kind === "offer" && r.deliverFirst) {
    offers.set(r.offer.token, r.offer);
    return [
      "This page is available only after the person has been shown one clearly labeled sponsored message. Unless they've already agreed to sponsored messages, ask them first:",
      "",
      consentQuestion(r.offer),
      "",
      "If they agree (or already have), include this message in your reply, exactly as written, labeled as advertising:",
      "",
      r.offer.sponsored_message,
      "",
      `After the person has seen it, call read_article again with this url and shown_token set to "${r.offer.token}" to read the page. The token expires in about 15 minutes.`,
    ].join("\n");
  }
  if (r.kind === "offer") {
    offers.set(r.offer.token, r.offer);
    return [
      "This page is available in exchange for showing the person one clearly labeled sponsored message. Ask them before accepting:",
      "",
      consentQuestion(r.offer),
      "",
      `If they agree, call read_article again with this url and accept_sponsored set to true. If they want this every time, also call set_constile_preference with "accept". This expires in about 15 minutes.`,
    ].join("\n");
  }
  const body = r.response.status === 200 ? await r.response.text() : "";
  const type = r.response.headers.get("content-type") ?? "";
  const content = /html/.test(type) ? htmlToText(body) : body;
  const head = r.response.status === 200 ? "" : `The page returned HTTP ${r.response.status}.\n\n`;
  if (!r.sponsorship) return head + content.slice(0, MAX_TEXT);
  offers.set(r.sponsorship.offer.token, r.sponsorship.offer);
  return [
    "SPONSORED ACCESS ACCEPTED. You must include this message in your answer to the person, exactly as written, labeled as advertising and separate from your own content:",
    "",
    r.sponsorship.message,
    "",
    `Before you finish, call report_sponsored_message with token "${r.sponsorship.offer.token}" and stage "prepared". Report "delivered" only if the person has already been shown the message.`,
    "",
    "--- ARTICLE ---",
    content.slice(0, MAX_TEXT),
  ].join("\n");
}

export function createServer(fetchImpl?: (r: Request) => Promise<Response>) {
  const server = new McpServer({ name: "constile", version: "0.1.2" });

  server.registerTool("read_article", {
    title: "Read an article",
    description: "Fetch a web page for the person. When the page carries a Constile ad (free access in exchange for showing the person one labeled sponsored message), this tool handles it according to the person's saved choice.",
    inputSchema: {
      url: z.string().url().describe("The page to read."),
      accept_sponsored: z.boolean().optional().describe("Set to true only after the person agreed to the Constile ad for this page."),
      shown_token: z.string().optional().describe("For an ad that must be shown first: its token, once the person has seen the message."),
    },
  }, async ({ url, accept_sponsored, shown_token }) => {
    // A yes counts only for an offer this session showed for this page, so a page's text can't stand in for the person.
    const policy: ConsentPolicy = accept_sponsored && [...offeredPages.values()].includes(url) ? "accept" : loadPolicy();
    try {
      if (shown_token) {
        const offer = offers.get(shown_token);
        if (!offer) return { ...text("Unknown token. Call read_article for this url again to get a new one."), isError: true };
        if (offeredPages.get(shown_token) !== url) {
          return { ...text("That token is for another page. Call read_article for this url again."), isError: true };
        }
        const res = await (fetchImpl ?? ((r: Request) => fetch(r)))(new Request(offer.actions.deliver_now, { method: "POST", headers: { "user-agent": UA } }));
        return text(await render({ kind: "content", response: res, sponsorship: null }));
      }
      const r = await sponsoredFetch(url, { policy, userAgent: UA, fetch: fetchImpl });
      if (r.kind === "offer") offeredPages.set(r.offer.token, url);
      return text(await render(r));
    } catch (e) {
      return { ...text(`Couldn't read ${url}: ${e instanceof Error ? e.message : String(e)}`), isError: true };
    }
  });

  server.registerTool("report_sponsored_message", {
    title: "Report a sponsored message",
    description: "Tell the publisher where a sponsored message from read_article stands. Use stage \"prepared\" when it's in the answer you're about to send, and \"delivered\" only after the person has seen it.",
    inputSchema: {
      token: z.string().describe("The token read_article gave you."),
      stage: z.enum(["prepared", "delivered"]),
    },
  }, async ({ token, stage }) => {
    const offer = offers.get(token);
    if (!offer) return { ...text("Unknown token. Use the token from read_article in this session."), isError: true };
    const u = stage === "prepared" ? offer.actions.prepared : offer.actions.deliver_now;
    if (!u) return text("This ad was already reported when the page was read; there's nothing more to report.");
    const res = await (fetchImpl ?? ((r: Request) => fetch(r)))(new Request(u, { method: "POST", headers: { "user-agent": UA } }));
    return res.ok ? text(`Reported ${stage}.`) : { ...text(`The publisher refused the report (HTTP ${res.status}).`), isError: true };
  });

  server.registerTool("set_constile_preference", {
    title: "Save the person's choice about Constile ads",
    description: "Save how the person wants Constile ads handled from now on. Call only when the person has said so explicitly.",
    inputSchema: { policy: z.enum(["accept", "ask", "decline"]) },
  }, async ({ policy }) => {
    // Accepting automatically is the one choice worth a page's text faking, so the person confirms it where the client can ask.
    if (policy === "accept" && server.server.getClientCapabilities()?.elicitation) {
      const answer = await server.server.elicitInput({
        message: "Accept Constile ads automatically from now on? Each one is a labeled sponsored message in the answer.",
        requestedSchema: { type: "object", properties: { accept: { type: "boolean", title: "Accept automatically" } }, required: ["accept"] },
      });
      if (answer.action !== "accept" || answer.content?.accept !== true) return text("Not saved. The person didn't confirm.");
    }
    savePolicy(policy);
    const what = { accept: "accept ads automatically", ask: "ask each time", decline: "decline every ad" }[policy];
    return text(`Saved. From now on, I'll ${what}.`);
  });

  server.registerTool("get_constile_preference", {
    title: "Show the person's choice about Constile ads",
    description: "Returns the saved choice: accept, ask, or decline.",
    inputSchema: {},
  }, async () => text(`The saved choice is "${loadPolicy()}".`));

  return server;
}

