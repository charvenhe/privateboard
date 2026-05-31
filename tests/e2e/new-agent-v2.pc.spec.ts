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

  test("in-app recording produces an audio material that becomes the voice source", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await page.waitForSelector("[data-agent-composer-trigger]", { state: "attached" });
    await page.evaluate(() => (document.querySelector("[data-agent-composer-trigger]") as HTMLElement).click());
    await expect(page.locator(".ag-extras")).toBeVisible();

    // Self-gate: some hosts (observed: macOS local) have a fake-audio pipeline
    // where getUserMedia({audio}) never resolves, hanging the recorder. Skip
    // cleanly there; runs + passes on Linux CI where fake audio works.
    const micOk = await page.evaluate(() => new Promise<boolean>((res) => {
      const t = setTimeout(() => res(false), 2500);
      navigator.mediaDevices.getUserMedia({ audio: true })
        .then((s) => { s.getTracks().forEach((x) => x.stop()); clearTimeout(t); res(true); })
        .catch(() => { clearTimeout(t); res(false); });
    }));
    test.skip(!micOk, "fake-audio getUserMedia unavailable on this host (passes on Linux CI)");

    const recBtn = page.locator("[data-agent-rec]");
    await expect(recBtn).toBeVisible();

    // Start recording — label flips to stop and the button gains `.on`.
    await recBtn.click();
    await expect(recBtn).toHaveClass(/(^|\s)on(\s|$)/);
    await expect(page.locator("[data-agent-rec] .ag-rec-lbl")).toContainText("停止录音");

    // Let the fake-audio MediaRecorder buffer a beat before stopping.
    await page.waitForTimeout(700);

    // Stop — clip uploads and appears as an audio chip named "录音-…".
    await recBtn.click();
    const recChip = page.locator("[data-agent-materials-chips] .ag-chip", { hasText: /^录音-/ });
    await expect(recChip).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("[data-agent-materials-chips] .ag-chip.is-uploading")).toHaveCount(0, { timeout: 10_000 });

    // The recorded clip auto-becomes the voice source.
    await expect(recChip).toHaveClass(/(^|\s)is-voice(\s|$)/);
    await expect(recChip.locator(".ag-chip-voice.on")).toBeVisible();
  });
});
