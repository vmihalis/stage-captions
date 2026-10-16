import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (process.platform === 'darwin') {
  const bundle = join(process.cwd(), 'build', 'mac', 'StageWindowLayout.app', 'Contents');
  const output = join(bundle, 'MacOS', 'StageWindowLayout');
  mkdirSync(join(bundle, 'MacOS'), { recursive: true });
  writeFileSync(join(bundle, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.stagecaptions.desktop.windowlayout</string>
<key>CFBundleName</key><string>StageWindowLayout</string>
<key>CFBundleExecutable</key><string>StageWindowLayout</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>0.1.6</string>
<key>LSUIElement</key><true/>
</dict></plist>`);
  const result = spawnSync('xcrun', ['swiftc', '-O', '-framework', 'AppKit', '-framework', 'ApplicationServices',
    'electron/window-layout.swift', '-o', output], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
  const check = spawnSync(output, ['--self-test'], { stdio: 'inherit' });
  if (check.error) throw check.error;
  if (check.status !== 0) process.exit(check.status || 1);
}
