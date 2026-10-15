import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: './mobile/e2e',
  outputDir: './mobile/test-results',
  reporter: [['list']],
  timeout: 30_000,
  use: {
    baseURL: 'http://127.0.0.1:19420',
    headless: true
  },
  projects: [
    {
      name: 'desktop',
      use: {
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        isMobile: false,
        headless: process.env.HEADED_LAYOUT !== '1',
        browserName: 'chromium',
        launchOptions: { args: ['--no-sandbox'], executablePath: '/usr/bin/google-chrome' }
      }
    },
    {
      name: 'iphone',
      use: {
        ...devices['iPhone 13'],
        browserName: 'chromium',
        launchOptions: { args: ['--no-sandbox'], executablePath: '/usr/bin/google-chrome' }
      }
    },
    {
      name: 'ipad',
      use: {
        ...devices['iPad Pro 11'],
        browserName: 'chromium',
        launchOptions: { args: ['--no-sandbox'], executablePath: '/usr/bin/google-chrome' }
      }
    },
    {
      name: 'iphone-webkit',
      use: {
        ...devices['iPhone 13'],
        browserName: 'webkit',
        launchOptions: { executablePath: process.env.WEBKIT_TEST_EXECUTABLE }
      }
    },
    {
      name: 'ipad-webkit',
      use: {
        ...devices['iPad Pro 11'],
        browserName: 'webkit',
        launchOptions: { executablePath: process.env.WEBKIT_TEST_EXECUTABLE }
      }
    }
  ]
})
