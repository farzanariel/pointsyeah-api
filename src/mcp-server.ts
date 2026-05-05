import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const PORT = Number(process.env.PORT ?? 9180);
const HOST = process.env.HOST ?? "127.0.0.1";
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

if (!AUTH_TOKEN) {
  console.error("FATAL: MCP_AUTH_TOKEN env var is required");
  process.exit(1);
}

function runSearch(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", "src/test-search.ts", ...args, "--json"], {
      cwd: PROJECT_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => stdout.push(c));
    child.stderr.on("data", (c: Buffer) => stderr.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code !== 0) {
        reject(new Error(`search exited ${code}: ${err.slice(-2000)}`));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error(`bad JSON from search: ${(e as Error).message}; stderr=${err.slice(-500)}`));
      }
    });
  });
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "pointsyeah", version: "0.1.0" });

  server.registerTool(
    "search_flights",
    {
      title: "Search award flights with cash comparison",
      description:
        "Searches PointsYeah for award availability (miles + tax) and matches each result against Google Flights cash prices, returning cents-per-point (CPP). Use this to decide whether to redeem points or pay cash for a flight.",
      inputSchema: {
        from: z.string().length(3).describe("Origin IATA code, e.g. JFK"),
        to: z.string().length(3).describe("Destination IATA code, e.g. LAX"),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Departure date YYYY-MM-DD"),
        returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Return date for round-trip search"),
        flex: z.number().int().min(0).max(60).optional().describe("Search +N days from date for flexible dates"),
        cabin: z.array(z.enum(["economy", "premium", "business", "first"])).optional(),
        nonstop: z.boolean().optional(),
        maxStops: z.number().int().min(0).optional(),
        maxMiles: z.number().int().positive().optional(),
        maxTax: z.number().positive().optional(),
        bank: z.array(z.enum(["amex", "chase", "citi", "bilt", "capital-one"])).optional(),
        program: z.array(z.string()).optional().describe("Loyalty program codes, e.g. UA, AA, DL"),
        airline: z.array(z.string()).optional().describe("Operating airline IATA codes, e.g. B6, UA"),
        sort: z.enum(["miles", "duration", "tax", "departure", "cpp"]).optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    async (input) => {
      const args: string[] = [input.from.toUpperCase(), input.to.toUpperCase(), input.date];
      if (input.returnDate) args.push("--return", input.returnDate);
      if (input.flex !== undefined) args.push("--flex", String(input.flex));
      if (input.cabin) for (const c of input.cabin) args.push("--cabin", c);
      if (input.nonstop) args.push("--nonstop");
      if (input.maxStops !== undefined) args.push("--max-stops", String(input.maxStops));
      if (input.maxMiles !== undefined) args.push("--max-miles", String(input.maxMiles));
      if (input.maxTax !== undefined) args.push("--max-tax", String(input.maxTax));
      if (input.bank) for (const b of input.bank) args.push("--bank", b);
      if (input.program) for (const p of input.program) args.push("--program", p);
      if (input.airline) for (const a of input.airline) args.push("--airline", a);
      if (input.sort) args.push("--sort", input.sort);
      if (input.limit !== undefined) args.push("--limit", String(input.limit));

      const result = await runSearch(args);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  return server;
}

function checkAuth(req: http.IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (!header) return false;
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return m[1].trim() === AUTH_TOKEN;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

const httpServer = http.createServer(async (req, res) => {
  const reqId = Math.random().toString(36).slice(2, 8);
  console.log(`[mcp ${reqId}] ${req.method} ${req.url} accept=${req.headers.accept ?? "-"} ct=${req.headers["content-type"] ?? "-"}`);

  if (req.url !== "/mcp") {
    res.writeHead(404).end("not found");
    console.log(`[mcp ${reqId}] -> 404 (path)`);
    return;
  }
  if (!checkAuth(req)) {
    res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end("unauthorized");
    console.log(`[mcp ${reqId}] -> 401 (auth)`);
    return;
  }

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = buildServer();
    await server.connect(transport);
    let body: unknown;
    if (req.method === "POST") {
      body = await readBody(req);
      console.log(`[mcp ${reqId}] body=${JSON.stringify(body).slice(0, 300)}`);
    }
    await transport.handleRequest(req, res, body);
    console.log(`[mcp ${reqId}] -> ${res.statusCode}`);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (e) {
    console.error(`[mcp ${reqId}] failed:`, e);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null }));
    }
  }
});

httpServer.listen(PORT, HOST, () => {
  console.log(`[mcp] pointsyeah MCP listening on http://${HOST}:${PORT}/mcp`);
});
