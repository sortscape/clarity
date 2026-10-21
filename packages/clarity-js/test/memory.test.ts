import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * Memory tests - load the built clarity.module.js in a browser and check that Clarity
 * stops tracking nodes once they are removed from the document. Clarity keeps a record
 * of every tracked node (attributes and selectors) and a reference to the node itself, so
 * a removed node it keeps tracking also keeps its whole detached subtree in memory.
 */

const origin = "https://clarity.test/";
const moduleJs = readFileSync(join(__dirname, "../build/clarity.module.js"), "utf-8");
const html = "<!doctype html><html><head></head><body><div id='root'></div><script type='module'>" +
    "import { clarity, helper } from '/clarity.module.js';" +
    "window.clarityHelper = helper;" +
    "clarity.start({ projectId: 'test', track: false, upload: function () {}, mask: ['.masked'] });" +
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
    await page.waitForFunction(() => (window as any).clarityHelper !== undefined);
    await page.waitForTimeout(500);
}

// Nodes created by the page under test, kept by index so tests can ask about them later.
async function tracked(page: Page, key: string): Promise<number> {
    return page.evaluate((k: string): number => {
        let helper = (window as any).clarityHelper;
        let nodes: Node[] = (window as any)[k];
        return nodes.filter((n: Node): boolean => {
            let value = helper.get(n);
            return value !== null && helper.getNode(value.id) !== null;
        }).length;
    }, key);
}

async function recorded(page: Page, key: string): Promise<number> {
    return page.evaluate((k: string): number => {
        let helper = (window as any).clarityHelper;
        return ((window as any)[k] as Node[]).filter((n: Node): boolean => helper.get(n) !== null).length;
    }, key);
}

// A mutation after the wait, so Clarity encodes a batch (and prunes).
async function touch(page: Page): Promise<void> {
    await page.evaluate(() => { document.getElementById("root").setAttribute("data-touch", String(Date.now())); });
    await page.waitForTimeout(300);
}

test.describe("memory - removed nodes", () => {
    test.beforeEach(async ({ page }) => { await open(page); });

    test("does not track links in a subtree removed before Clarity saw it", async ({ page }) => {
        await page.evaluate(() => {
            let row = document.createElement("div");
            let link = document.createElement("a");
            link.href = "/jobs";
            link.textContent = "job";
            row.appendChild(link);
            document.getElementById("root").appendChild(row);
            row.remove();
            (window as any).removed = [row, link, link.firstChild];
        });
        await page.waitForTimeout(500);

        expect(await tracked(page, "removed")).toBe(0);
    });
    test("does not track the rest of a subtree removed while Clarity was walking it", async ({ page }) => {
        await page.evaluate(() => {
            let row = document.createElement("div");
            let nodes: Node[] = [row];
            for (let i = 0; i < 4000; i++) {
                let cell = document.createElement("div");
                cell.className = "cell";
                cell.textContent = "visit " + i;
                row.appendChild(cell);
                nodes.push(cell, cell.firstChild);
            }
            document.getElementById("root").appendChild(row);
            (window as any).removed = nodes;
            // Once Clarity has started walking the row (it yields between slices), remove it.
            setTimeout(() => row.remove(), 50);
        });
        await page.waitForTimeout(3000);

        expect(await tracked(page, "removed")).toBe(0);
    });
    test("drops the records of a removed subtree", async ({ page }) => {
        await page.evaluate(() => {
            let row = document.createElement("div");
            let nodes: Node[] = [row];
            for (let i = 0; i < 20; i++) {
                let cell = document.createElement("div");
                cell.textContent = "visit " + i;
                row.appendChild(cell);
                nodes.push(cell, cell.firstChild);
            }
            document.getElementById("root").appendChild(row);
            (window as any).removed = nodes;
        });
        await page.waitForTimeout(500);
        expect(await recorded(page, "removed")).toBe(41);

        await page.evaluate(() => { ((window as any).removed[0] as Element).remove(); });
        await page.waitForTimeout(2500);
        await touch(page);

        expect(await recorded(page, "removed")).toBe(0);
    });
    test("keeps tracking a removed node that is put back", async ({ page }) => {
        await page.evaluate(() => {
            let row = document.createElement("div");
            let cell = document.createElement("span");
            cell.textContent = "visit";
            row.appendChild(cell);
            document.getElementById("root").appendChild(row);
            (window as any).moved = [row, cell, cell.firstChild];
        });
        await page.waitForTimeout(500);
        await page.evaluate(() => {
            let row = (window as any).moved[0] as Element;
            row.remove();
            setTimeout(() => document.getElementById("root").appendChild(row), 100);
        });
        await page.waitForTimeout(2500);
        await touch(page);

        expect(await tracked(page, "moved")).toBe(3);
    });
    test("stops tracking nodes removed by mutations it throttles while the page is idle", async ({ page }) => {
        // Clarity throttles a mutation that keeps repeating without user interaction and keeps
        // only the latest of each kind; the removals of the ones it drops must still count.
        await page.evaluate(() => {
            let root = document.getElementById("root");
            let removed: Node[] = [];
            (window as any).removed = removed;
            let round = 0;
            let timer = setInterval(() => {
                let column = document.createElement("div");
                for (let j = 0; j < 20; j++) {
                    let card = document.createElement("div");
                    card.textContent = "visit";
                    column.appendChild(card);
                }
                let previous = root.firstElementChild;
                if (previous) {
                    removed.push(previous);
                    previous.querySelectorAll("*").forEach((n: Element) => removed.push(n, n.firstChild));
                }
                root.replaceChildren(column);
                if (++round === 60) { clearInterval(timer); }
            }, 100);
        });
        await page.waitForTimeout(10000);

        expect(await tracked(page, "removed")).toBe(0);
    });
});
