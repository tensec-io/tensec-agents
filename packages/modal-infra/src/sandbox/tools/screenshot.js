/**
 * Screenshot Tool — captures a browser screenshot using Playwright.
 *
 * Returns the image as a base64 data URL attachment so the LLM can see it,
 * and the bridge forwards it to the control plane for R2 storage + UI display.
 */
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"

export default tool({
  name: "screenshot",
  description:
    "Take a screenshot of a web page. Use this when doing frontend work to verify visual changes. " +
    "The screenshot will be shown to you as an image and also displayed to the user in the UI. " +
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

      const status = navigationError
        ? `Screenshot captured (${Math.round(buffer.length / 1024)} KB) but the page had a navigation error: ${navigationError}`
        : `Screenshot captured successfully (${Math.round(buffer.length / 1024)} KB).`

      return {
        title: `Screenshot of ${args.url}`,
        output: status,
        metadata: { url: args.url, fullPage: args.fullPage, sizeBytes: buffer.length },
        attachments: [
          {
            type: "file",
            mime: "image/png",
            url: dataUrl,
            filename: "screenshot.png",
          },
        ],
      }
    } catch (error) {
      return {
        title: `Screenshot failed`,
        output: `Failed to capture screenshot of ${args.url}: ${error.message}`,
        metadata: { url: args.url, error: error.message },
      }
    } finally {
      if (browser) {
        await browser.close().catch(() => {})
      }
    }
  },
})
