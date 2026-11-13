import AppKit
import WebKit

private let allowedHost = "127.0.0.1"

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var attachURL: URL?
    private var retryTimer: Timer?
    private var attached = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        attachURL = Self.parseAttach()
        buildWindow()
        Task { await load() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    private static func parseAttach() -> URL? {
        let arguments = CommandLine.arguments
        if let index = arguments.firstIndex(of: "--attach"), index + 1 < arguments.count,
           let url = URL(string: arguments[index + 1]) { return url }
        if let value = ProcessInfo.processInfo.environment["HARNESS_URL"], let url = URL(string: value) { return url }
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("myCodexHarness/attach.url")
        if let text = try? String(contentsOf: support, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
           let url = URL(string: text) { return url }
        return nil
    }

    private func buildWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.preferences.isElementFullscreenEnabled = true
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsMagnification = true
        webView.setValue(false, forKey: "drawsBackground")

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1360, height: 940),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "DeepSeek Harness"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.minSize = NSSize(width: 900, height: 640)
        window.contentView = webView
        window.center()

        let menu = NSMenu()
        let applicationItem = NSMenuItem()
        menu.addItem(applicationItem)
        let applicationMenu = NSMenu()
        applicationMenu.addItem(withTitle: "关于 Harness", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(withTitle: "重新载入", action: #selector(reload), keyEquivalent: "r")
        applicationMenu.addItem(withTitle: "重新打开设置", action: #selector(openSettings), keyEquivalent: "e")
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(withTitle: "隐藏 Harness", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        applicationMenu.addItem(withTitle: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        applicationMenu.addItem(withTitle: "全部显示", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(withTitle: "退出 Harness", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        applicationItem.submenu = applicationMenu

        let editItem = NSMenuItem()
        menu.addItem(editItem)
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu

        let viewItem = NSMenuItem()
        menu.addItem(viewItem)
        let viewMenu = NSMenu(title: "显示")
        viewMenu.addItem(withTitle: "放大", action: #selector(zoomIn), keyEquivalent: "+")
        viewMenu.addItem(withTitle: "缩小", action: #selector(zoomOut), keyEquivalent: "-")
        viewMenu.addItem(withTitle: "实际大小", action: #selector(zoomReset), keyEquivalent: "0")
        viewMenu.addItem(.separator())
        viewMenu.addItem(withTitle: "进入全屏", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        viewItem.submenu = viewMenu
        NSApp.mainMenu = menu

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func load() async {
        guard let url = attachURL else {
            showUnavailable("没有找到本机工作台入口。\n\n请先运行 workbench/launch.sh 启动 Node 后端，或双击「打开 Harness.command」。")
            return
        }
        webView.load(URLRequest(url: url))
        startRetry()
    }

    private func startRetry() {
        retryTimer?.invalidate()
        retryTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] timer in
            guard let self else { return timer.invalidate() }
            guard !self.attached else { return timer.invalidate() }
            guard let url = self.attachURL, !self.webView.isLoading else { return }
            self.webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 5))
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            self?.retryTimer?.invalidate()
        }
    }

    private func showUnavailable(_ message: String) {
        let label = NSTextField(wrappingLabelWithString: message)
        label.alignment = .center
        label.font = .systemFont(ofSize: 15)
        label.textColor = .secondaryLabelColor
        let container = NSView()
        label.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: container.centerYAnchor),
            label.widthAnchor.constraint(lessThanOrEqualToConstant: 480),
        ])
        window.contentView = container
    }

    @objc private func reload() { webView.reload() }

    @objc private func openSettings() {
        guard let attachURL, let origin = URLComponents(url: attachURL, resolvingAgainstBaseURL: false)?.scheme,
              var components = URLComponents(url: attachURL, resolvingAgainstBaseURL: false) else { return }
        _ = origin
        components.path = "/"
        components.query = nil
        if let url = components.url { NSWorkspace.shared.open(url) }
    }

    @objc private func zoomIn() { webView.pageZoom = min(2.0, webView.pageZoom + 0.1) }
    @objc private func zoomOut() { webView.pageZoom = max(0.5, webView.pageZoom - 0.1) }
    @objc private func zoomReset() { webView.pageZoom = 1.0 }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        attached = true
        retryTimer?.invalidate()
        window.title = webView.title?.isEmpty == false ? webView.title! : "DeepSeek Harness"
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.allow) }
        if url.scheme == "http" || url.scheme == "https" {
            if url.host == allowedHost { return decisionHandler(.allow) }
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        if url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" { return decisionHandler(.allow) }
        NSWorkspace.shared.open(url)
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { webView.load(URLRequest(url: url)) }
        return nil
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()