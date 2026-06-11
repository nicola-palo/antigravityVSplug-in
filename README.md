# Antigravity Panel (Unofficial)

> [!IMPORTANT]
> This is an **unofficial** independently developed extension. It is not affiliated with, sponsored by, or endorsed by Google or the Antigravity team. It requires the official Antigravity application to be installed on your local computer.

The **Antigravity Agent Manager inside VS Code and VSCodium**.

This extension does not re-implement Antigravity: it connects to the Antigravity application already installed on your computer and embeds its **real user interface** (served by the app's local language server) directly into a VS Code panel. This guarantees:

- **Identical Aesthetics** — It uses the actual Antigravity UI, not a visual clone.
- **Model Selector & Thinking** — The native options from the app (Gemini 3.5 Pro High/Low, Claude, etc.) remain fully functional.
- **Unified Session** — Uses the same account, preferences, and chat history as your standalone Antigravity app.
- **Workspace Sync** — The *Open Project* button lets you send your active VS Code folder directly to the Antigravity app.

## How It Works

The Antigravity desktop app starts a local language server (`language_server.exe`) that serves the Agent Manager interface over HTTPS on a random local port, using a self-signed certificate trusted by the app's Electron framework. The extension:

1. Finds the active Antigravity language server process and its HTTPS port.
2. Launches a lightweight local proxy that terminates TLS (accepting the self-signed certificate in Node.js) and serves the UI over plain HTTP on `127.0.0.1`.
3. Injects the "native bridges" (like `window.nativeStorage`, `electronNative`, and `dialog` shims) that the UI expects from the Electron preloader. This allows settings to be persisted by the extension, folder pickers to use VS Code APIs, and links to open in your default web browser.
4. Embeds the resulting HTTP page in a VS Code webview (available in the sidebar or as an editor tab).

If Antigravity is not running, the panel offers a **Launch Antigravity** button that boots the app, passes it the current project folder, and connects as soon as the server becomes available.

## Usage

- Click the **Antigravity** icon in the Activity Bar (sidebar).
- Or use the command palette: `Ctrl+Shift+P` → **Antigravity: Open Agent Manager in a Tab** (recommended for a wider layout).
- **Antigravity: Open Current Project Folder in Antigravity** opens your current workspace inside the Antigravity application.
- The **🚀 Antigravity** status bar item shows the connection state (✓ connected / ○ not running).

## Settings

| Setting | Description |
|---|---|
| `antigravityPanel.executablePath` | Path to `Antigravity.exe` (leave empty for automatic detection in `%LOCALAPPDATA%\Programs\Antigravity` on Windows) |
| `antigravityPanel.port` | HTTP port of the local server (0 = auto-detect) |
| `antigravityPanel.autoLaunch` | Automatically launch the Antigravity app if it is not running when you open the panel |

## Installation

```bash
code --install-extension antigravity-panel-0.2.13.vsix
codium --install-extension antigravity-panel-0.2.13.vsix
```

Or from VS Code/VSCodium: **Extensions (Ctrl+Shift+X) → "..." Menu → Install from VSIX...**

## Requirements

- The official [Antigravity](https://antigravity.google) application installed.
- Windows (auto-detected). macOS/Linux are supported by manually configuring `antigravityPanel.executablePath`.

## Privacy & Security

- The extension communicates exclusively with the local Antigravity server on `127.0.0.1`. No data is sent to external servers.
- Not affiliated with Google.

## License & Disclaimer

This project is licensed under the [MIT License](file:///C:/Users/nicola.palo/Desktop/Nuova%20cartella%20(2)/antigravity-panel/LICENSE).

> [!WARNING]
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

