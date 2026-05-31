/**
 * New-Agent v2 (PC) e2e — ONE unified attachments uploader in the new-agent
 * composer (`public/index.html` + `public/app.js`). Verifies the extras render,
 * a real upload to `/api/agents/materials/upload` produces a chip, an audio
 * material auto-becomes the voice source (🎙), and no chip overflows its
 * container at desktop width.
 *
 * Runs under the `pc-chromium` project (1440×900). Dev server up on :3030.
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
const MP3 = {
  name: "keynote-clip.mp3",
  mimeType: "audio/mpeg",
  buffer: Buffer.from("ID3 fake mp3 bytes for upload"),
};

test.describe("new-agent v2 · PC", () => {
  test("unified uploader: chips render, audio auto-becomes voice source, no overflow", async ({ page }) => {
    await page.goto(`${BASE}/`);
    // The trigger is a mask/::before icon button (zero-box to Playwright's
    // visibility check) wired through a document-level click delegate, so
    // dispatch a real bubbling click on the element directly.
    await page.waitForSelector("[data-agent-composer-trigger]", { state: "attached" });
    await page.evaluate(() => (document.querySelector("[data-agent-composer-trigger]") as HTMLElement).click());
    await expect(page.locator(".ag-extras")).toBeVisible();

    await page.setInputFiles("[data-agent-materials-input]", TXT);
    await expect(page.locator("[data-agent-materials-chips] .ag-chip").first()).toContainText("persona-brief.txt");
    await expect(page.locator("[data-agent-materials-chips] .ag-chip.is-uploading")).toHaveCount(0, { timeout: 10_000 });

    await page.setInputFiles("[data-agent-materials-input]", MP3);
    await expect(page.locator("[data-agent-materials-chips] .ag-chip.is-uploading")).toHaveCount(0, { timeout: 10_000 });
    const audioChip = page.locator("[data-agent-materials-chips] .ag-chip", { hasText: "keynote-clip.mp3" });
    await expect(audioChip).toHaveClass(/(^|\s)is-voice(\s|$)/);
    await expect(audioChip.locator(".ag-chip-voice.on")).toBeVisible();

    const chipOverflow = await page.evaluate(() => {
      const wrap = document.querySelector("[data-agent-materials-chips]");
      if (!wrap) return true;
      const right = wrap.getBoundingClientRect().right;
      return [...wrap.querySelectorAll(".ag-chip")].some((c) => c.getBoundingClientRect().right > right + 1);
    });
    expect(chipOverflow).toBe(false);
  });
});
