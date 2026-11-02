import UIKit
import WebKit

/// iPad host for the existing website. Retains a real UIPencilInteraction;
/// Safari and an Add to Home Screen web app do not instantiate this controller.
@MainActor
final class PencilWebViewController: UIViewController, WKNavigationDelegate, UIPencilInteractionDelegate {
    private let documentURL: URL
    private let webView = WKWebView(frame: .zero)

    init(documentURL: URL) {
        self.documentURL = documentURL
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("Use init(documentURL:)") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.navigationDelegate = self
        webView.scrollView.bounces = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        ])
        webView.addInteraction(UIPencilInteraction(delegate: self))
        webView.load(URLRequest(url: documentURL))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // The editor announces native support only when an actual host connects.
        webView.evaluateJavaScript("window.PencilControls?.nativeReady()", completionHandler: nil)
    }

    func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
        // On modern systems use didReceiveTap; avoid handling one double-tap twice.
        if #available(iOS 17.5, *) { return }
        send(UIPencilInteraction.preferredTapAction)
    }

    @available(iOS 17.5, *)
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveTap tap: UIPencilInteraction.Tap) {
        send(UIPencilInteraction.preferredTapAction)
    }

    @available(iOS 17.5, *)
    func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze) {
        // Pencil 2 has no squeeze sensor. This also supports a future Pencil Pro upgrade.
        guard squeeze.phase == .ended else { return }
        send(UIPencilInteraction.preferredSqueezeAction)
    }

    private func send(_ preferred: UIPencilPreferredAction) {
        let action: String
        switch preferred {
        case .switchEraser: action = "switchEraser"
        case .switchPrevious: action = "previous"
        case .showColorPalette: action = "colors"
        case .showInkAttributes: action = "attributes"
        case .ignore: return
        default:
            if #available(iOS 17.5, *), preferred == .showContextualPalette {
                action = "palette"
            } else {
                // System Shortcuts and unknown future actions belong to iPadOS.
                return
            }
        }
        webView.callAsyncJavaScript("return window.PencilControls?.perform(action) ?? false;",
            arguments: ["action": action], in: nil, in: .page, completionHandler: nil)
    }
}
