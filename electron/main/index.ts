import { app, BaseWindow, WebContentsView, ipcMain } from 'electron'
import { join } from 'path'
import { TabManager } from './tabs/TabManager'
import { registerIPCHandlers } from './ipc/handlers'

// Layout constants
const CHROME_HEIGHT = 78

let mainWindow: BaseWindow
let chromeView: WebContentsView
let commandCenterView: WebContentsView
let welcomeView: WebContentsView
let tabManager: TabManager
let showingCommandCenter = false

const welcomeHTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #11111b;
    color: #cdd6f4;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    -webkit-user-select: none;
  }
  .container {
    text-align: center;
    max-width: 500px;
  }
  .logo {
    font-size: 48px;
    font-weight: 800;
    letter-spacing: -2px;
    background: linear-gradient(135deg, #89b4fa, #cba6f7);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    margin-bottom: 12px;
  }
  .tagline {
    font-size: 15px;
    color: #6c7086;
    margin-bottom: 48px;
    letter-spacing: 0.5px;
  }
  .actions {
    display: flex;
    gap: 16px;
    justify-content: center;
  }
  a.action {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    padding: 28px 36px;
    border-radius: 16px;
    border: 1px solid #313244;
    background: #181825;
    cursor: pointer;
    transition: border-color 0.2s, background 0.2s;
    text-decoration: none;
    color: inherit;
  }
  a.action:hover {
    border-color: #45475a;
    background: #1e1e2e;
  }
  .action .icon {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 20px;
  }
  .action .icon.tab { background: #313244; }
  .action .icon.rlm { background: rgba(137, 180, 250, 0.15); }
  .action .label {
    font-size: 14px;
    font-weight: 600;
    color: #cdd6f4;
  }
  .action .hint {
    font-size: 12px;
    color: #585b70;
  }
  .shortcut {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 5px;
    background: #313244;
    font-size: 11px;
    font-weight: 500;
    color: #a6adc8;
    font-family: monospace;
  }
  .footer {
    margin-top: 56px;
    font-size: 12px;
    color: #45475a;
    letter-spacing: 0.3px;
  }
</style>
</head>
<body>
  <div class="container">
    <div class="logo">Ouroboros</div>
    <div class="tagline">Recursive Language Model Browser</div>
    <div class="actions">
      <a class="action" href="ouroboros://new-tab">
        <div class="icon tab">+</div>
        <div class="label">New Tab</div>
        <div class="hint"><span class="shortcut">+</span> in tab bar</div>
      </a>
      <a class="action" href="ouroboros://command-center">
        <div class="icon rlm">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#89b4fa" stroke-width="2.5">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <path d="M9 3v18"/><path d="M14 9l3 3-3 3"/>
          </svg>
        </div>
        <div class="label">Command Center</div>
        <div class="hint"><span class="shortcut">RLM</span> in tab bar</div>
      </a>
    </div>
    <div class="footer">Browse the web. Let the model do the rest.</div>
  </div>
</body>
</html>`

function createWindow() {
  mainWindow = new BaseWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    titleBarOverlay: false,
  })

  // Chrome view (tab bar + address bar) — always visible at top
  chromeView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/chrome.js'),
      sandbox: true,
    },
  })
  mainWindow.contentView.addChildView(chromeView)

  // Command Center view — toggled in/out of the content area
  commandCenterView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/command-center.js'),
      sandbox: true,
    },
  })
  // Don't add it yet — starts hidden

  // Welcome view — shown when no tabs are open
  welcomeView = new WebContentsView({
    webPreferences: { sandbox: true },
  })
  welcomeView.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(welcomeHTML)}`)
  welcomeView.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (url === 'ouroboros://new-tab') {
      tabManager.openTab()
    } else if (url === 'ouroboros://command-center') {
      showingCommandCenter = true
      layoutViews()
    }
  })

  // Tab manager owns user tab views
  tabManager = new TabManager(mainWindow, () => {
    const [width, height] = mainWindow.getContentSize()
    return { x: 0, y: CHROME_HEIGHT, width, height: height - CHROME_HEIGHT }
  })

  // Provide chromeView to tab manager for IPC forwarding
  tabManager.setChromeView(chromeView)

  // Re-layout when tabs change so welcome view toggles properly
  tabManager.onTabCountChange = () => layoutViews()

  // Register IPC handlers
  registerIPCHandlers(tabManager, commandCenterView)

  // Toggle command center IPC
  ipcMain.handle('view:toggle-command-center', () => {
    showingCommandCenter = !showingCommandCenter
    layoutViews()
    return showingCommandCenter
  })

  ipcMain.handle('view:is-command-center', () => {
    return showingCommandCenter
  })

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

  mainWindow.on('resize', layoutViews)
}

function layoutViews() {
  const [width, height] = mainWindow.getContentSize()
  const contentBounds = { x: 0, y: CHROME_HEIGHT, width, height: height - CHROME_HEIGHT }

  // Chrome bar always spans full width
  chromeView.setBounds({ x: 0, y: 0, width, height: CHROME_HEIGHT })

  if (showingCommandCenter) {
    // Hide active tab + welcome, show command center
    tabManager.hideActiveTab()
    mainWindow.contentView.removeChildView(welcomeView)
    mainWindow.contentView.addChildView(commandCenterView)
    commandCenterView.setBounds(contentBounds)
  } else if (tabManager.getActiveTabId()) {
    // Hide command center + welcome, show active tab
    mainWindow.contentView.removeChildView(commandCenterView)
    mainWindow.contentView.removeChildView(welcomeView)
    tabManager.layoutActiveTab()
  } else {
    // No tabs, no command center — show welcome
    mainWindow.contentView.removeChildView(commandCenterView)
    mainWindow.contentView.addChildView(welcomeView)
    welcomeView.setBounds(contentBounds)
  }
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
  if (tabManager) tabManager.destroyAll()
  app.quit()
})
