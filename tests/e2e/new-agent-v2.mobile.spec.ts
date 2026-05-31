/**
 * New-Agent v2 (mobile) e2e — local voice-source upload + materials-driven
 * persona creation on `public/m/index.html`. Verifies the controls render, a
 * real upload to `/api/agents/materials/upload` produces a chip, the submit
 * payload carries `materials` + `voiceSource` (no client-only fields leaking),
 * and the layout has NO overlapping elements at 390px.
 *
 * Runs under the `mobile-chromium` project (390×844). The dev server must be
 * up on :3030 (the config has no webServer).
 *
 *     npx playwright test new-agent-v2.mobile
 */
import { expect, test, type Page } from "@playwright/test";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3030";

const TXT = {
  name: "persona-brief.txt",
  mimeType: "text/plain",
  buffer: Buffer.from("A contrarian value investor who distrusts hype and asks for unit economics."),
};
const WAV = {
  name: "voice-sample.wav",
  mimeType: "audio/wav",
  buffer: Buffer.from("RIFF    WAVEfmt "),
};

async function gotoNewAgent(page: Page): Promise<void> {
  await page.goto(`${BASE}/m/`);
  await page.waitForFunction(() => typeof (window as unknown as { goto?: unknown }).goto === "function");
  await page.evaluate(() => (window as unknown as { goto: (s: string) => void }).goto("new-agent"));
}

test.describe("new-agent v2 · mobile", () => {
  test("controls render, upload yields a chip, no layout overlap", async ({ page }) => {
    await gotoNewAgent(page);

    await expect(page.locator("#na-voice-section")).toBeVisible();
    await expect(page.locator("#na-materials-section")).toBeVisible();
    // The chosen-row must stay hidden until a voice file is picked.
    await expect(page.locator("#na-voice-chosen")).toBeHidden();

    // Real upload → chip.
    await page.setInputFiles("#na-materials-input", TXT);
    const chip = page.locator("#na-materials-chips .na-chip").first();
    await expect(chip).toContainText("persona-brief.txt");
    await expect(page.locator("#na-materials-chips .na-chip.is-uploading")).toHaveCount(0, { timeout: 10_000 });

    // Voice source upload → chosen row appears.
    await page.setInputFiles("#na-voice-input", WAV);
    await expect(page.locator("#na-voice-chosen")).toBeVisible();
    await expect(page.locator("#na-voice-chosen-name")).toContainText("voice-sample.wav");

    // No chip overflows its container.
    const chipOverflow = await page.evaluate(() => {
      const wrap = document.getElementById("na-materials-chips");
      if (!wrap) return true;
      const right = wrap.getBoundingClientRect().right;
      return [...wrap.querySelectorAll(".na-chip")].some((c) => c.getBoundingClientRect().right > right + 1);
    });
    expect(chipOverflow).toBe(false);

    // Submit button clears the fixed tab bar (no overlap) once scrolled.
    await page.evaluate(() => window.scrollTo(0, 99_999));
    const clearGap = await page.evaluate(() => {
      const s = document.getElementById("new-agent-submit");
      const t = document.querySelector(".tabbar");
      if (!s || !t) return -1;
      return Math.round(t.getBoundingClientRect().top - s.getBoundingClientRect().bottom);
    });
    expect(clearGap).toBeGreaterThanOrEqual(0);
  });

  test("submit sends materials + voiceSource, strips client-only fields", async ({ page }) => {
    let body: { materials?: Array<Record<string, unknown>>; voiceSource?: { filePath?: string } } | null = null;
    await page.route("**/api/agents/generate-persona", async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "e2e-test" }) });
    });
    // Keep the build-progress SSE from hanging the page.
    await page.route("**/api/agents/generate-persona/*/stream", (route) =>
      route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }),
    );

    await gotoNewAgent(page);
    await page.fill("#new-agent-desc", "A contrarian value investor for the board.");
    await page.setInputFiles("#na-materials-input", TXT);
    await expect(page.locator("#na-materials-chips .na-chip.is-uploading")).toHaveCount(0, { timeout: 10_000 });
    await page.setInputFiles("#na-voice-input", WAV);
    await expect(page.locator("#na-voice-chosen")).toBeVisible();

    await page.click("#new-agent-submit");
    await expect.poll(() => body, { timeout: 10_000 }).not.toBeNull();

    const sent = body as NonNullable<typeof body>;
    expect(Array.isArray(sent.materials)).toBe(true);
    expect(sent.materials!.length).toBeGreaterThanOrEqual(1);
    expect(typeof sent.voiceSource?.filePath).toBe("string");
    for (const m of sent.materials!) {
      expect(m._key).toBeUndefined();
      expect(m.pending).toBeUndefined();
      expect(typeof m.filePath).toBe("string");
    }
  });
});
