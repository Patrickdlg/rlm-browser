import { app, BaseWindow, WebContentsView, session } from 'electron'
import { join } from 'path'
import { TabManager } from './tabs/TabManager'
import { registerIPCHandlers } from './ipc/handlers'

// Layout constants
const CHROME_HEIGHT = 72
const COMMAND_CENTER_WIDTH_RATIO = 0.35
const MIN_COMMAND_CENTER_WIDTH = 350

let mainWindow: BaseWindow
let chromeView: WebContentsView
let commandCenterView: WebContentsView
let tabManager: TabManager

function createWindow() {
  mainWindow = new BaseWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    titleBarOverlay: false,
  })

  // Chrome view (tab bar + address bar)
  chromeView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/chrome.js'),
      sandbox: true,
    },
  })
  mainWindow.contentView.addChildView(chromeView)

  // Command Center view
  commandCenterView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/command-center.js'),
      sandbox: true,
    },
  })
  mainWindow.contentView.addChildView(commandCenterView)

  // Tab manager owns user tab views
  tabManager = new TabManager(mainWindow, () => {
    // Provide the current tab area bounds
    const [width, height] = mainWindow.getContentSize()
    const ccWidth = Math.max(MIN_COMMAND_CENTER_WIDTH, Math.round(width * COMMAND_CENTER_WIDTH_RATIO))
    const tabWidth = width - ccWidth
    return { x: 0, y: CHROME_HEIGHT, width: tabWidth, height: height - CHROME_HEIGHT }
  })

  // Provide chromeView to tab manager for IPC forwarding
  tabManager.setChromeView(chromeView)

  // Register IPC handlers
  registerIPCHandlers(tabManager, commandCenterView)

  // Layout all views
  layoutViews()

  // Load renderer apps
  if (process.env.ELECTRON_RENDERER_URL) {
    chromeView.webContents.loadURL(`${process.env.ELECTRON_RENDERER_URL}/src/chrome/index.html`)
    commandCenterView.webContents.loadURL(`${process.env.ELECTRON_RENDERER_URL}/src/command-center/index.html`)
  } else {
    chromeView.webContents.loadFile(join(__dirname, '../renderer/src/chrome/index.html'))
    commandCenterView.webContents.loadFile(join(__dirname, '../renderer/src/command-center/index.html'))
  }

  // Open a default tab
  tabManager.openTab('about:blank')

  mainWindow.on('resize', layoutViews)
}

function layoutViews() {
  const [width, height] = mainWindow.getContentSize()
  const ccWidth = Math.max(MIN_COMMAND_CENTER_WIDTH, Math.round(width * COMMAND_CENTER_WIDTH_RATIO))
  const tabWidth = width - ccWidth

  chromeView.setBounds({ x: 0, y: 0, width: tabWidth, height: CHROME_HEIGHT })
  commandCenterView.setBounds({ x: tabWidth, y: 0, width: ccWidth, height: height })

  // Reposition active tab
  tabManager.layoutActiveTab()
}

// Global safety net for unhandled rejections
process.on('unhandledRejection', (reason, _promise) => {
  console.error('[RLM] Unhandled rejection caught:', reason)
  if (commandCenterView && !commandCenterView.webContents.isDestroyed()) {
    commandCenterView.webContents.send('rlm:error', {
      error: `Unhandled async error: ${reason}`,
    })
  }
})

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  // Cleanup tab views
  if (tabManager) tabManager.destroyAll()
  app.quit()
})
