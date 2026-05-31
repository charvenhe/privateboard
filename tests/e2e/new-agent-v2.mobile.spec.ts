/**
 * New-Agent v2 (mobile) e2e — ONE unified attachments uploader that seeds the
 * persona AND auto-derives the voice-clone source (first audio/video material).
 * Verifies controls render, a real upload to `/api/agents/materials/upload`
 * produces a chip, an audio material auto-becomes the voice source (🎙), the
 * submit payload carries `materials` + the auto `voiceSource`, and the layout
 * has NO overlapping elements at 390px.
 *
 * Runs under the `mobile-chromium` project (390×844). Dev server up on :3030.
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
const MP3 = {
  name: "keynote-clip.mp3",
  mimeType: "audio/mpeg",
  buffer: Buffer.from("ID3 fake mp3 bytes for upload"),
};

async function gotoNewAgent(page: Page): Promise<void> {
  await page.goto(`${BASE}/m/`);
  await page.waitForFunction(() => typeof (window as unknown as { goto?: unknown }).goto === "function");
  await page.evaluate(() => (window as unknown as { goto: (s: string) => void }).goto("new-agent"));
}

test.describe("new-agent v2 · mobile", () => {
  test("unified uploader: chips render, audio auto-becomes voice source, no overlap", async ({ page }) => {
    await gotoNewAgent(page);

    await expect(page.locator("#na-materials-section")).toBeVisible();
    // No separate voice control any more — one uploader.
    await expect(page.locator("#na-voice-section")).toHaveCount(0);

    // A text material → plain chip, no 🎙 toggle.
    await page.setInputFiles("#na-materials-input", TXT);
    await expect(page.locator("#na-materials-chips .na-chip").first()).toContainText("persona-brief.txt");
    await expect(page.locator("#na-materials-chips .na-chip.is-uploading")).toHaveCount(0, { timeout: 10_000 });

    // An audio material → carries a 🎙 toggle AND, as the first audio/video,
    // is auto-selected as the voice source (active toggle + .is-voice chip).
    await page.setInputFiles("#na-materials-input", MP3);
    await expect(page.locator("#na-materials-chips .na-chip.is-uploading")).toHaveCount(0, { timeout: 10_000 });
    const audioChip = page.locator("#na-materials-chips .na-chip", { hasText: "keynote-clip.mp3" });
    await expect(audioChip).toHaveClass(/(^|\s)is-voice(\s|$)/);
    await expect(audioChip.locator(".na-chip-voice.on")).toBeVisible();

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

  test("submit sends materials + auto-derived voiceSource, strips client-only fields", async ({ page }) => {
    let body: { materials?: Array<Record<string, unknown>>; voiceSource?: { filePath?: string } } | null = null;
    await page.route("**/api/agents/generate-persona", async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: "e2e-test" }) });
    });
    await page.route("**/api/agents/generate-persona/*/stream", (route) =>
      route.fulfill({ status: 200, contentType: "text/event-stream", body: "" }),
    );

    await gotoNewAgent(page);
    await page.fill("#new-agent-desc", "A contrarian value investor for the board.");
    await page.setInputFiles("#na-materials-input", TXT);
    await page.setInputFiles("#na-materials-input", MP3);
    await expect(page.locator("#na-materials-chips .na-chip.is-uploading")).toHaveCount(0, { timeout: 10_000 });
    // The audio material must be auto-selected as the voice source before submit.
    await expect(
      page.locator("#na-materials-chips .na-chip", { hasText: "keynote-clip.mp3" }).locator(".na-chip-voice.on"),
    ).toBeVisible();

    await page.click("#new-agent-submit");
    await expect.poll(() => body, { timeout: 10_000 }).not.toBeNull();

    const sent = body as NonNullable<typeof body>;
    expect(Array.isArray(sent.materials)).toBe(true);
    expect(sent.materials!.length).toBe(2); // text + audio
    expect(typeof sent.voiceSource?.filePath).toBe("string");
    // voiceSource must point at the audio material that's in the materials list.
    const audio = sent.materials!.find((m) => m.kind === "audio");
    expect(audio).toBeTruthy();
    expect(sent.voiceSource!.filePath).toBe(audio!.filePath);
    for (const m of sent.materials!) {
      expect(m._key).toBeUndefined();
      expect(m.pending).toBeUndefined();
      expect(typeof m.filePath).toBe("string");
    }
  });
});
