/**
 * Screenshot Tool — captures a browser screenshot using Playwright.
 *
 * Saves the PNG to disk and writes a JSON sidecar with the base64 data URL.
 * The bridge reads the sidecar when the tool_call completes and forwards
 * the image to the control plane for R2 storage + web UI display.
 *
 * Returns a plain string (OpenCode plugin framework requirement).
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { mkdirSync, writeFileSync } from "node:fs"

const SCREENSHOT_DIR = "/tmp/screenshots"

export default tool({
  name: "screenshot",
  description:
    "Take a screenshot of a web page. Use this when doing frontend work to verify visual changes. " +
    "The screenshot will be displayed to the user in the UI. " +
    "Provide a URL (e.g. http://localhost:3000) and optionally set fullPage to capture the entire page.",
  args: {
    url: z.string().url().describe("The URL to screenshot (e.g. http://localhost:3000)."),
    fullPage: z
      .boolean()
      .optional()
      .default(false)
      .describe("Capture the full scrollable page instead of just the viewport."),
  },
  async execute(args) {
    let browser
    try {
      // Dynamic import — playwright is installed globally in the sandbox image
      const { chromium } = await import("playwright")

      browser = await chromium.launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      })
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })

      // Catch navigation errors (connection refused, DNS failure, HTTP errors)
      // so we still capture the browser's error page as the screenshot.
      let navigationError
      try {
        await page.goto(args.url, { waitUntil: "networkidle", timeout: 30000 })
      } catch (err) {
        navigationError = err.message
      }

      const buffer = await page.screenshot({
        fullPage: args.fullPage,
        type: "png",
      })

      const base64 = buffer.toString("base64")
      const dataUrl = `data:image/png;base64,${base64}`
      const sizeKB = Math.round(buffer.length / 1024)

      // Persist to disk so the bridge can pick up the image data
      mkdirSync(SCREENSHOT_DIR, { recursive: true })
      writeFileSync(`${SCREENSHOT_DIR}/screenshot.png`, buffer)
      writeFileSync(
        `${SCREENSHOT_DIR}/pending.json`,
        JSON.stringify({
          type: "file",
          mime: "image/png",
          filename: "screenshot.png",
          dataUrl,
        })
      )

      if (navigationError) {
        return `Screenshot captured (${sizeKB} KB) but the page had a navigation error: ${navigationError}\nSaved to ${SCREENSHOT_DIR}/screenshot.png`
      }
      return `Screenshot captured successfully (${sizeKB} KB).\nSaved to ${SCREENSHOT_DIR}/screenshot.png`
    } catch (error) {
      return `Failed to capture screenshot of ${args.url}: ${error.message}`
    } finally {
      if (browser) {
        await browser.close().catch(() => {})
      }
    }
  },
})
