import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function parseTriageInput(raw) {
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const { text } = body;
  if (typeof text !== "string" || text.trim() === "") return null;
  return text;
}

const MODEL_TIMEOUT_MS = 300;
const TOPICS = new Set(["delivery", "pricing", "other"]);
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

async function askModel(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  const timeout = new Promise((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error("Model timeout")), { once: true });
  });
  try {
    return await Promise.race([classify(text, { signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function parseModelOutput(raw) {
  if (typeof raw !== "string") return null;
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    return null;
  }
  if (result === null || typeof result !== "object" || Array.isArray(result)) return null;
  const { topic, draft } = result;
  if (!TOPICS.has(topic)) return null;
  if (typeof draft !== "string" || draft.trim() === "") return null;
  return { topic, draft };
}

async function handleTriage(request, response) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = parseTriageInput(Buffer.concat(chunks).toString("utf8"));
  if (text === null) return json(response, 400, { status: "invalid_input" });

  let result = null;
  try {
    result = parseModelOutput(await askModel(text));
  } catch {
    result = null;
  }
  if (result === null) return json(response, 200, MANUAL_REVIEW);
  return json(response, 200, { status: "ready", ...result });
}

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }
  if (request.method !== "POST" || request.url !== "/api/triage") {
    return json(response, 404, { status: "not_found" });
  }
  try {
    await handleTriage(request, response);
  } catch {
    json(response, 500, { status: "server_error" });
  }
}).listen(Number(process.env.PORT || 3000), "127.0.0.1");
