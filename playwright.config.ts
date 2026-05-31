import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:3030",
    headless: true,
    ignoreHTTPSErrors: true,
    actionTimeout: 6_000,
  },
  projects: [
    {
      // Desktop / PC app (public/index.html, served at "/"). PC is the
      // reference implementation; mobile must match its logic/behavior.
      name: "pc-chromium",
      testMatch: /pc\.spec\.ts/,
      use: {
        browserName: "chromium",
        viewport: { width: 1440, height: 900 },
        // Fake mic + auto-grant getUserMedia so MediaRecorder actually
        // produces audio for the in-app voice recording e2e. Harmless to
        // non-media tests — the fake device only activates on getUserMedia.
        permissions: ["microphone"],
        launchOptions: {
          args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
        },
      },
    },
    {
      name: "mobile-chromium",
      testMatch: /mobile\.spec\.ts/,
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
        // Fake mic + auto-grant getUserMedia so MediaRecorder actually
        // produces audio for the in-app voice recording e2e. Harmless to
        // non-media tests — the fake device only activates on getUserMedia.
        permissions: ["microphone"],
        launchOptions: {
          args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
        },
      },
    },
  ],
});
