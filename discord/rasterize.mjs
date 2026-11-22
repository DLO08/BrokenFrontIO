#!/usr/bin/env node
/**
 * Rasterize the BrokenFront mark into the PNGs Discord needs.
 *
 * Discord will not accept SVG for a server icon, so we composite the bare mark
 * onto a full-bleed ink plate (no rounded corners -- Discord masks the icon to a
 * circle, and rounded corners would leave four slivers of nothing) and screenshot
 * it with headless Edge/Chrome.
 *
 * Usage: node discord/rasterize.mjs
 * Output: discord/brand/icon-512.png, discord/brand/icon-1024.png
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const OUT_DIR = path.join(ROOT, "discord/brand");

const BROWSERS = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) {
  console.error("No Chromium-based browser found. Edit BROWSERS in discord/rasterize.mjs.");
  process.exit(1);
}

const INK = "#161310";
const mark = await readFile(path.join(ROOT, "resources/images/BrokenFrontMarkBare.svg"), "utf8");

// Strip the outer <svg> tag so we can re-wrap it at our own size.
const inner = mark.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");

await mkdir(OUT_DIR, { recursive: true });

for (const size of [512, 1024]) {
  const html = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: ${INK}; }
  body { width: ${size}px; height: ${size}px; overflow: hidden; }
  svg { display: block; width: ${size}px; height: ${size}px; }
</style>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${inner}</svg>`;

  const tmpHtml = path.join(os.tmpdir(), `bf-icon-${size}-${process.pid}.html`);
  const outPng = path.join(OUT_DIR, `icon-${size}.png`);
  await writeFile(tmpHtml, html, "utf8");

  await run(browser, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    `--window-size=${size},${size}`,
    `--screenshot=${outPng}`,
    `file:///${tmpHtml.replace(/\\/g, "/")}`,
  ]).catch((e) => {
    // Chrome exits non-zero on some Windows builds even after writing the file.
    if (!existsSync(outPng)) throw e;
  });

  if (!existsSync(outPng)) {
    console.error(`failed to write ${outPng}`);
    process.exit(1);
  }
  console.log(`  + discord/brand/icon-${size}.png`);
}

console.log("\nicon-512.png is what apply.mjs uploads as the server icon.");
console.log("icon-1024.png is spare, for the Developer Portal app avatar and socials.");
