import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

const outputRoot = new URL("../pages-dist/", import.meta.url);

test("builds a GitHub Pages-ready static entry point", async () => {
  const html = await readFile(new URL("index.html", outputRoot), "utf8");

  assert.match(html, /<title>Boardly｜板書を、きれいな1枚に。<\/title>/);
  assert.match(html, /https:\/\/hiromame-s46\.github\.io\/cam-dev\/og\.png/);
  assert.match(html, /\/cam-dev\/assets\/[^"']+\.js/);
  assert.match(html, /\/cam-dev\/assets\/[^"']+\.css/);
  assert.doesNotMatch(html, /chatgpt\.site|codex-preview/);
  await access(new URL("og.png", outputRoot));
});

test("ships the scanner UI and local-only processing code", async () => {
  const assetNames = await readdir(new URL("assets/", outputRoot));
  const scriptName = assetNames.find((name) => name.endsWith(".js"));
  assert.ok(scriptName, "JavaScript bundle should exist");
  const script = await readFile(new URL(`assets/${scriptName}`, outputRoot), "utf8");

  assert.match(script, /Boardly/);
  assert.match(script, /application\/pdf/);
  assert.match(script, /boardly-note\.png/);
  assert.match(script, /boardly-note\.pdf/);
});
