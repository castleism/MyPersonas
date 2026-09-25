import Network
import UIKit
import WebKit

/// Debug WKWebView over the real MyPersonas owner command center.
/// This is not a social publisher. publishing_enabled stays false.
final class OwnerViewController: UIViewController, WKNavigationDelegate {
    static let defaultOrigin = URL(string: "https://mypersonas.online/#/owner")!
    static let exportVersion = "mobile-owner-workflow-export-v1"
    static let prefsKey = "owner_origin"

    private let web = WKWebView()
    private let monitor = NWPathMonitor()
    private let monitorQueue = DispatchQueue(label: "online.mypersonas.owner.network")
    private var showingOffline = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        web.navigationDelegate = self
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)

        let export = UIButton(type: .system)
        export.setTitle("Export local prefs", for: .normal)
        export.addTarget(self, action: #selector(exportPrefs), for: .touchUpInside)
        let importButton = UIButton(type: .system)
        importButton.setTitle("Import local prefs", for: .normal)
        importButton.addTarget(self, action: #selector(importPrefs), for: .touchUpInside)
        let reload = UIButton(type: .system)
        reload.setTitle("Reload when online", for: .normal)
        reload.addTarget(self, action: #selector(reloadOwner), for: .touchUpInside)
        let sites = UIButton(type: .system)
        sites.setTitle("Websites to check", for: .normal)
        sites.addTarget(self, action: #selector(openSites), for: .touchUpInside)
        let bar = UIStackView(arrangedSubviews: [export, importButton, sites, reload])
        bar.axis = .horizontal
        bar.distribution = .fillEqually
        bar.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(bar)

        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 8),
            bar.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -8),
            web.topAnchor.constraint(equalTo: bar.bottomAnchor, constant: 8),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            web.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])

        monitor.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async {
                self?.networkChanged(online: path.status == .satisfied)
            }
        }
        monitor.start(queue: monitorQueue)
        loadOwnerSurface(nil)
    }

    deinit {
        monitor.cancel()
    }

    static let ownerSurfaces: Set<String> = [
        "owner", "feed", "push", "sites", "briefs", "schedule", "activity", "notifications"
    ]

    func allowedOwnerURL(_ url: URL) -> Bool {
        guard let host = url.host else { return false }
        let local = host == "localhost" || host == "127.0.0.1"
        let live = host == "mypersonas.online"
        guard local || live else { return false }
        if url.scheme == "https" {
            // live or local TLS
        } else if url.scheme == "http" && local {
            // laptop Pages only
        } else {
            return false
        }
        let path = url.path
        if !path.isEmpty && path != "/" { return false }
        guard let fragment = url.fragment, !fragment.isEmpty else { return true }
        var route = fragment.hasPrefix("/") ? String(fragment.dropFirst()) : fragment
        if let slash = route.firstIndex(of: "/") {
            route = String(route[..<slash])
        }
        if let query = route.firstIndex(of: "?") {
            route = String(route[..<query])
        }
        return Self.ownerSurfaces.contains(route)
    }

    func openOwnerURL(_ url: URL) -> Bool {
        guard allowedOwnerURL(url) else { return false }
        loadOwnerSurface(url)
        return true
    }

    @objc func reloadOwner() {
        loadOwnerSurface(nil)
    }

    @objc func openSites() {
        let stored = UserDefaults.standard.string(forKey: Self.prefsKey) ?? Self.defaultOrigin.absoluteString
        let root = stored.split(separator: "#").first.map(String.init) ?? "https://mypersonas.online"
        let trimmed = root.hasSuffix("/") ? String(root.dropLast()) : root
        if let url = URL(string: trimmed + "/#/sites") {
            loadOwnerSurface(url)
        }
    }

    func openExternalHTTPS(_ url: URL) -> Bool {
        guard url.scheme == "https", url.host != nil else { return false }
        UIApplication.shared.open(url, options: [:], completionHandler: nil)
        return true
    }

    func loadOwnerSurface(_ override: URL?) {
        if monitor.currentPath.status != .satisfied {
            showingOffline = true
            if let offline = Bundle.main.url(forResource: "offline-limitations", withExtension: "html") {
                web.loadFileURL(offline, allowingReadAccessTo: offline.deletingLastPathComponent())
            }
            return
        }
        let stored = UserDefaults.standard.string(forKey: Self.prefsKey).flatMap(URL.init(string:))
        let target = override ?? stored ?? Self.defaultOrigin
        guard allowedOwnerURL(target) else {
            showingOffline = false
            web.load(URLRequest(url: Self.defaultOrigin))
            return
        }
        showingOffline = false
        web.load(URLRequest(url: target))
    }

    func networkChanged(online: Bool) {
        if online, showingOffline {
            loadOwnerSurface(nil)
        } else if !online {
            showingOffline = true
            if let offline = Bundle.main.url(forResource: "offline-limitations", withExtension: "html") {
                web.loadFileURL(offline, allowingReadAccessTo: offline.deletingLastPathComponent())
            }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        if allowedOwnerURL(url) || url.scheme == "file" {
            decisionHandler(.allow)
            return
        }
        if url.scheme == "https" {
            _ = openExternalHTTPS(url)
        }
        decisionHandler(.cancel)
    }

    @objc func exportPrefs() {
        let origin = UserDefaults.standard.string(forKey: Self.prefsKey) ?? Self.defaultOrigin.absoluteString
        let bundle: [String: Any] = [
            "version": Self.exportVersion,
            "owner_origin": origin,
            "publishing_enabled": false,
            "note": "Local debug prefs only. Does not include private draft bodies or secrets."
        ]
        guard JSONSerialization.isValidJSONObject(bundle),
              let data = try? JSONSerialization.data(withJSONObject: bundle, options: [.prettyPrinted]) else { return }
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("owner-mobile-prefs.json")
        try? data.write(to: url)
    }

    @objc func importPrefs() {
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("owner-mobile-prefs.json")
        guard let data = try? Data(contentsOf: url),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        guard object["version"] as? String == Self.exportVersion else { return }
        guard (object["publishing_enabled"] as? Bool) != true else { return }
        guard let origin = object["owner_origin"] as? String, let parsed = URL(string: origin), allowedOwnerURL(parsed) else { return }
        UserDefaults.standard.set(origin, forKey: Self.prefsKey)
        loadOwnerSurface(nil)
    }
}
