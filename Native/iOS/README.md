# Apple Pencil hardware integration

The existing project is a Java server and a website. Browser Pointer Events supply
pressure and tilt, but do not expose the Pencil 2 double-tap or Pencil Pro squeeze
as a standard DOM event. Adding the site to the Home Screen does not install this
UIKit host.

`PencilWebViewController.swift` is a native host for an iPad app target (iOS 14+;
build with an SDK containing iOS 17.5+). It displays the existing site in WKWebView,
connects `UIPencilInteraction` to `window.PencilControls`, and respects the user's
system preference instead of hard-coding every hardware gesture to erasing.

In an Xcode iPad application target, add this source and present:

```swift
let controller = PencilWebViewController(
    documentURL: URL(string: "https://YOUR_APP_HOST/login.html")!
)
window.rootViewController = controller
window.makeKeyAndVisible()
```

Use the deployment URL for the existing app. For local development, the iPad
must reach the computer's LAN address; `localhost` on the iPad is the iPad itself.
Any local HTTP transport exception and local-network permission must be configured
in that iOS target for the chosen development host.

The host sends `switchEraser`, `previous`, `colors`, `attributes`, or `palette`.
The editor defers an action received during a live stroke until pen-up, retaining
the whole stroke and the original tool's ink. An ordinary double-tap on paper is
left to the existing text/table editor; it is not treated as a Pencil gesture.

The UIKit host has not been compiled on Windows. Build/sign and hardware validation
require macOS/Xcode and a compatible iPad/Pencil. No iOS application binary or
Xcode project is supplied by this file.

References:

- [UIPencilInteraction](https://developer.apple.com/documentation/uikit/uipencilinteraction)
- [Handling double taps](https://developer.apple.com/documentation/applepencil/handling-double-taps-from-apple-pencil)
- [Handling squeezes](https://developer.apple.com/documentation/applepencil/handling-squeezes-from-apple-pencil)
- [Pointer Events pressure](https://www.w3.org/TR/pointerevents3/#dom-pointerevent-pressure)
