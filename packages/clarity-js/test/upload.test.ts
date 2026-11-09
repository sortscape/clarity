import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * Upload tests - load the built clarity.module.js in a browser and stop Clarity while an
 * upload is waiting for its payload to compress. Clarity stops on its own after 5 minutes
 * without interaction (suspend) and at its limits, so in a tab left open this happens.
 */

const origin = "https://clarity.test/";
const moduleJs = readFileSync(join(__dirname, "../build/clarity.module.js"), "utf-8");

// Holds each compression until the test lets the oldest finish, so the test can stop Clarity in between.
const html = "<!doctype html><html><head></head><body><div id='root'></div><script>" +
    "window.rejections = []; window.uploads = []; window.compressing = 0; window.held = [];" +
    "window.addEventListener('unhandledrejection', function (e) { window.rejections.push(String(e.reason)); });" +
    "var arrayBuffer = Response.prototype.arrayBuffer;" +
    "Response.prototype.arrayBuffer = function () {" +
    "  var response = this; window.compressing++;" +
    "  return new Promise(function (resolve) { window.held.push(resolve); })" +
    "    .then(function () { return arrayBuffer.call(response); });" +
    "};" +
    "</script><script type='module'>" +
    "import { clarity } from '/clarity.module.js';" +
    "window.clarity = clarity;" +
    "window.startClarity = function () {" +
    "  clarity.start({ projectId: 'test', track: false, delay: 100, upload: function (p) { window.uploads.push(p); } });" +
    "};" +
    "window.startClarity();" +
    "</script></body></html>";

async function open(page: Page): Promise<void> {
    await page.route(`${origin}**`, async (route: Route): Promise<void> => {
        let path = new URL(route.request().url()).pathname;
        if (path === "/clarity.module.js") {
            await route.fulfill({ contentType: "text/javascript", body: moduleJs });
        } else if (path === "/") {
            await route.fulfill({ contentType: "text/html", body: html });
        } else {
            await route.abort();
        }
    });
    await page.goto(origin);
    // The first upload is waiting on compression.
    await page.waitForFunction(() => (window as any).compressing > 0);
}

async function finishCompressing(page: Page): Promise<void> {
    await page.evaluate(() => { (window as any).held.shift()(); });
    await page.waitForTimeout(300);
}

test.describe("upload - Clarity stops while a payload compresses", () => {
    test.beforeEach(async ({ page }) => { await open(page); });

    test("does not throw when Clarity stopped meanwhile", async ({ page }) => {
        await page.evaluate(() => { (window as any).clarity.stop(); });
        let uploads = await page.evaluate(() => (window as any).uploads.length);
        await finishCompressing(page);

        expect(await page.evaluate(() => (window as any).rejections)).toEqual([]);
        // The payload belonged to the instance that stopped, which already sent its final one.
        expect(await page.evaluate(() => (window as any).uploads.length)).toBe(uploads);
    });

    test("does not send it for the instance that started meanwhile", async ({ page }) => {
        await page.evaluate(() => { (window as any).clarity.stop(); (window as any).startClarity(); });
        let uploads = await page.evaluate(() => (window as any).uploads.length);
        await finishCompressing(page);

        expect(await page.evaluate(() => (window as any).rejections)).toEqual([]);
        expect(await page.evaluate(() => (window as any).uploads.length)).toBe(uploads);
    });

    test("still sends it when Clarity kept running", async ({ page }) => {
        let uploads = await page.evaluate(() => (window as any).uploads.length);
        await finishCompressing(page);

        expect(await page.evaluate(() => (window as any).rejections)).toEqual([]);
        expect(await page.evaluate(() => (window as any).uploads.length)).toBe(uploads + 1);
    });
});
