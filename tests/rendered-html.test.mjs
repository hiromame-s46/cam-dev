import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("renders the Boardly application shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /Boardly/);
  assert.match(html, /板書を、/);
  assert.match(html, /写真を撮る・選ぶ/);
  assert.match(html, /サンプルで試す/);
  assert.match(html, /画像は端末内だけで処理/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("includes local image processing and both download formats", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /function detectBoard/);
  assert.match(page, /function warpBoard/);
  assert.match(page, /function makePdf/);
  assert.match(page, /image\/png/);
  assert.match(page, /application\/pdf/);
  assert.match(page, /capture="environment"/);
  assert.doesNotMatch(page, /fetch\(|XMLHttpRequest|FormData/);
});
