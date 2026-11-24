import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

let server;
let baseUrl;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function triage(body) {
  return fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

before(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: { ...process.env, PORT: String(port) },
    stdio: "inherit",
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await fetch(baseUrl);
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error("Server did not start");
});

after(() => server?.kill());

test("returns ready with topic and draft for a normal request", async () => {
  const reply = await triage({ text: "Когда будет доставка?" });
  assert.equal(reply.status, 200);
  assert.deepEqual(await reply.json(), {
    status: "ready",
    topic: "delivery",
    draft: "Спасибо за обращение. Уточним детали заявки.",
  });
});

for (const body of ["", "{", "null", "[]", {}, { text: "" }, { text: "   " }, { text: 42 }]) {
  test(`returns invalid_input for ${JSON.stringify(body)}`, async () => {
    const reply = await triage(body);
    assert.equal(reply.status, 400);
    assert.deepEqual(await reply.json(), { status: "invalid_input" });
  });
}

for (const tag of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`returns manual_review when the model fails: ${tag}`, async () => {
    const started = performance.now();
    const reply = await triage({ text: `Вопрос по доставке ${tag}` });
    const elapsed = performance.now() - started;
    assert.equal(reply.status, 200);
    assert.deepEqual(await reply.json(), { status: "manual_review", topic: null, draft: null });
    assert.ok(elapsed < 600, `response took ${Math.round(elapsed)} ms`);
  });
}
