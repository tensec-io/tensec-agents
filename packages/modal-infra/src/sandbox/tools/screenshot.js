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
import { mkdirSync, writeFileSync, copyFileSync, appendFileSync } from "node:fs"

const SCREENSHOT_DIR = "/tmp/screenshots"
const ARCHIVE_DIR = `${SCREENSHOT_DIR}/archive`
const LOG_PATH = `${SCREENSHOT_DIR}/screenshot.log`

function log(message) {
  try {
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`)
  } catch {}
}

function logError(message, error) {
  log(`ERROR: ${message}${error ? ` — ${error.message || error}` : ""}`)
}

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
      log(`Starting screenshot — url=${args.url} fullPage=${args.fullPage}`)

      // Dynamic import — playwright is installed globally in the sandbox image
      const { chromium } = await import("playwright")

      browser = await chromium.launch({
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      })
      log("Browser launched")
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })

      let networkIdleReached = true
      try {
        await page.goto(args.url, { waitUntil: "networkidle", timeout: 15000 })
      } catch (err) {
        networkIdleReached = false
        logError("Navigation warning (continuing to capture)", err)
      }

      const buffer = await page.screenshot({
        fullPage: args.fullPage,
        type: "png",
      })

      const base64 = buffer.toString("base64")
      const dataUrl = `data:image/png;base64,${base64}`
      const sizeKB = Math.round(buffer.length / 1024)
      log(`Screenshot captured — ${sizeKB} KB`)

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
      log("Sidecar pending.json written")

      // Archive the PNG so previous captures are preserved
      try {
        mkdirSync(ARCHIVE_DIR, { recursive: true })
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
        copyFileSync(`${SCREENSHOT_DIR}/screenshot.png`, `${ARCHIVE_DIR}/${timestamp}-screenshot.png`)
        log(`Archived to ${ARCHIVE_DIR}/${timestamp}-screenshot.png`)
      } catch (archiveErr) {
        logError("Failed to archive screenshot", archiveErr)
      }

      const idle = networkIdleReached ? "" : " (network idle not reached — page may still be loading)"
      return `Screenshot captured (${sizeKB} KB)${idle}.\nSaved to ${SCREENSHOT_DIR}/screenshot.png`
    } catch (error) {
      logError("Fatal error", error)
      return `Failed to capture screenshot of ${args.url}: ${error.message}`
    } finally {
      if (browser) {
        await browser.close().catch(() => {})
        log("Browser closed")
      }
    }
  },
})
