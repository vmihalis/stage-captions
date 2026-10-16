import AppKit
import ApplicationServices
import Darwin
import Foundation

// Stage's optional macOS window layout helper. It only changes the focused,
// resizable standard window on the caption display; it never reads window text.
private struct Frame {
    var x: CGFloat
    var y: CGFloat
    var width: CGFloat
    var height: CGFloat

    var rect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
}

private struct AdjustedWindow {
    let element: AXUIElement
    let original: Frame
    var applied: Frame
}

private func frame(_ element: AXUIElement) -> Frame? {
    var positionRef: CFTypeRef?
    var sizeRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionRef) == .success,
          AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success,
          let positionRef, let sizeRef,
          CFGetTypeID(positionRef) == AXValueGetTypeID(),
          CFGetTypeID(sizeRef) == AXValueGetTypeID() else { return nil }
    let positionValue = positionRef as! AXValue
    let sizeValue = sizeRef as! AXValue
    var position = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionValue, .cgPoint, &position),
          AXValueGetValue(sizeValue, .cgSize, &size) else { return nil }
    return Frame(x: position.x, y: position.y, width: size.width, height: size.height)
}

private func setFrame(_ element: AXUIElement, _ target: Frame) -> Bool {
    var position = CGPoint(x: target.x, y: target.y)
    var size = CGSize(width: target.width, height: target.height)
    guard let positionValue = AXValueCreate(.cgPoint, &position),
          let sizeValue = AXValueCreate(.cgSize, &size) else { return false }
    // Resize before moving so a window never extends further into the strip.
    let sized = AXUIElementSetAttributeValue(element, kAXSizeAttribute as CFString, sizeValue) == .success
    let moved = AXUIElementSetAttributeValue(element, kAXPositionAttribute as CFString, positionValue) == .success
    return sized && moved
}

private func isStandardResizableWindow(_ element: AXUIElement) -> Bool {
    var subroleRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &subroleRef) == .success,
          (subroleRef as? String) == "AXStandardWindow" else { return false }
    var fullscreenRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(element, "AXFullScreen" as CFString, &fullscreenRef) == .success,
       (fullscreenRef as? Bool) == true { return false }
    var positionSettable = DarwinBoolean(false)
    var sizeSettable = DarwinBoolean(false)
    guard AXUIElementIsAttributeSettable(element, kAXPositionAttribute as CFString, &positionSettable) == .success,
          AXUIElementIsAttributeSettable(element, kAXSizeAttribute as CFString, &sizeSettable) == .success else { return false }
    return positionSettable.boolValue && sizeSettable.boolValue
}

private func fitted(_ original: Frame, display: Frame, safe: Frame) -> Frame? {
    guard original.width > 0, original.height > 0,
          display.rect.contains(CGPoint(x: original.x + original.width / 2, y: original.y + original.height / 2)) else { return nil }
    let width = min(original.width, safe.width)
    let height = min(original.height, safe.height)
    let x = min(max(original.x, safe.x), safe.x + safe.width - width)
    let y = min(max(original.y, safe.y), safe.y + safe.height - height)
    let result = Frame(x: x, y: y, width: width, height: height)
    let epsilon: CGFloat = 1
    if abs(result.x - original.x) < epsilon && abs(result.y - original.y) < epsilon &&
       abs(result.width - original.width) < epsilon && abs(result.height - original.height) < epsilon { return nil }
    return result
}

private func sameFrame(_ left: Frame, _ right: Frame) -> Bool {
    abs(left.x - right.x) <= 2 && abs(left.y - right.y) <= 2 &&
    abs(left.width - right.width) <= 2 && abs(left.height - right.height) <= 2
}

private func announce(_ state: String) {
    print("{\"state\":\"\(state)\"}")
    fflush(stdout)
}

private func parseFrame(_ args: ArraySlice<String>) -> Frame? {
    let numbers = args.compactMap(Double.init)
    guard numbers.count == 4, numbers.allSatisfy({ $0.isFinite && abs($0) < 100_000 }),
          numbers[2] > 0, numbers[3] > 0 else { return nil }
    return Frame(x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3])
}

if CommandLine.arguments.contains("--self-test") {
    let display = Frame(x: 0, y: 25, width: 1680, height: 1000)
    let safe = Frame(x: 0, y: 25, width: 1680, height: 730)
    let full = Frame(x: 0, y: 25, width: 1680, height: 1000)
    let small = Frame(x: 100, y: 800, width: 500, height: 200)
    guard fitted(full, display: display, safe: safe)?.height == 730,
          fitted(small, display: display, safe: safe)?.y == 555,
          fitted(Frame(x: 100, y: 100, width: 500, height: 300), display: display, safe: safe) == nil else { exit(1) }
    announce("self-test-passed")
    exit(0)
}

let arguments = CommandLine.arguments
guard arguments.count == 11, arguments[1] == "--watch",
      let display = parseFrame(arguments[2...5]),
      let safe = parseFrame(arguments[6...9]),
      let parentPID = Int32(arguments[10]), parentPID > 0,
      display.rect.contains(safe.rect) else {
    fputs("Invalid Stage window layout bounds.\n", stderr)
    exit(2)
}

let promptOptions = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
var trusted = AXIsProcessTrustedWithOptions(promptOptions)
if !trusted { announce("permission-required") }
var readyAnnounced = false
private var adjusted: [String: AdjustedWindow] = [:]
private var lastWindowState = ""
private func reportWindowState(_ state: String) {
    if state != lastWindowState { announce(state); lastWindowState = state }
}

while getppid() == parentPID {
    if !trusted { trusted = AXIsProcessTrusted() }
    if trusted {
        if !readyAnnounced { announce("ready"); readyAnnounced = true }
        if let application = NSWorkspace.shared.frontmostApplication,
           application.processIdentifier != parentPID,
           application.processIdentifier != getpid(),
           application.bundleIdentifier != "com.stagecaptions.desktop",
           application.bundleIdentifier != "com.apple.systempreferences" {
            let appElement = AXUIElementCreateApplication(application.processIdentifier)
            var windowRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowRef) == .success,
               let windowRef, CFGetTypeID(windowRef) == AXUIElementGetTypeID() {
                let window = windowRef as! AXUIElement
                if isStandardResizableWindow(window), let current = frame(window) {
                    if let target = fitted(current, display: display, safe: safe) {
                        let key = "\(application.processIdentifier):\(CFHash(window))"
                        let previous = adjusted[key]
                        if setFrame(window, target) {
                            adjusted[key] = AdjustedWindow(element: window, original: previous?.original ?? current,
                                                           applied: frame(window) ?? target)
                            reportWindowState("adjusted")
                        } else { reportWindowState("resize-failed") }
                    } else { reportWindowState("already-clear-or-other-display") }
                } else { reportWindowState("unsupported-window") }
            } else { reportWindowState("no-focused-window") }
        }
    }
    var input = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN | POLLHUP), revents: 0)
    if poll(&input, 1, 350) > 0 {
        if input.revents & Int16(POLLHUP) != 0 { break }
        if input.revents & Int16(POLLIN) != 0 {
            var bytes = [UInt8](repeating: 0, count: 32)
            let count = read(STDIN_FILENO, &bytes, bytes.count)
            if count <= 0 || String(decoding: bytes[0..<count], as: UTF8.self).contains("stop") { break }
        }
    }
}

for entry in adjusted.values {
    if let current = frame(entry.element), sameFrame(current, entry.applied) {
        _ = setFrame(entry.element, entry.original)
    }
}
announce("stopped")
