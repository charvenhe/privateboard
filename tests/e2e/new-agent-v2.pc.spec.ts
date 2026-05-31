/**
 * New-Agent v2 (PC) e2e — local voice-source upload + materials uploads in the
 * new-agent composer (`public/index.html` + `public/app.js`). Verifies the
 * extras render, a real upload to `/api/agents/materials/upload` produces a
 * chip, and no chip overflows its container at desktop width.
 *
 * Runs under the `pc-chromium` project (1440×900). The dev server must be up
 * on :3030 (the config has no webServer).
 *
 *     npx playwright test new-agent-v2.pc
 */
import { expect, test } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3030";

const TXT = {
  name: "persona-brief.txt",
  mimeType: "text/plain",
  buffer: Buffer.from("A contrarian value investor who distrusts hype and asks for unit economics."),
};

test.describe("new-agent v2 · PC", () => {
  test("composer extras render, upload yields a chip, no overflow", async ({ page }) => {
    await page.goto(`${BASE}/`);
    // The trigger is a mask/::before icon button (zero-box to Playwright's
    // visibility check) wired through a document-level click delegate, so
    // dispatch a real bubbling click on the element directly.
    await page.waitForSelector("[data-agent-composer-trigger]", { state: "attached" });
    await page.evaluate(() => (document.querySelector("[data-agent-composer-trigger]") as HTMLElement).click());
    await expect(page.locator(".ag-extras")).toBeVisible();

    await page.setInputFiles("[data-agent-materials-input]", TXT);
    const chip = page.locator("[data-agent-materials-chips] .ag-chip").first();
    await expect(chip).toContainText("persona-brief.txt");
    await expect(page.locator("[data-agent-materials-chips] .ag-chip.is-uploading")).toHaveCount(0, { timeout: 10_000 });

    const chipOverflow = await page.evaluate(() => {
      const wrap = document.querySelector("[data-agent-materials-chips]");
      if (!wrap) return true;
      const right = wrap.getBoundingClientRect().right;
      return [...wrap.querySelectorAll(".ag-chip")].some((c) => c.getBoundingClientRect().right > right + 1);
    });
    expect(chipOverflow).toBe(false);
  });
});
