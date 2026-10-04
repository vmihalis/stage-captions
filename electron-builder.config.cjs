module.exports = {
  appId: 'com.stagecaptions.desktop',
  productName: 'Stage',
  asar: true,
  directories: { output: 'release' },
  files: ['electron/**/*', 'package.json'],
  extraMetadata: { main: 'electron/main.cjs', dependencies: {},
    ...(process.env.STAGE_APP_HOMEPAGE ? { homepage: process.env.STAGE_APP_HOMEPAGE } : {}) },
  artifactName: 'Stage-${version}-${os}-${arch}.${ext}',
  // Release automation uploads the finished files; the builder never receives a publishing token.
  publish: null,
  mac: {
    category: 'public.app-category.productivity',
    target: ['dmg', 'zip'],
    // Pilot packages have no Apple Developer signing identity or notarization credentials.
    identity: null,
    notarize: false,
    hardenedRuntime: true,
    entitlements: 'electron/entitlements.mac.plist',
    entitlementsInherit: 'electron/entitlements.mac.plist',
    extendInfo: {
      NSMicrophoneUsageDescription: 'Stage uses your microphone to create live Japanese captions while you present.',
    },
  },
  win: { target: ['nsis'] },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true, perMachine: false },
  linux: {
    target: ['AppImage', 'deb'],
    category: 'Office',
    synopsis: 'Live Japanese captions for presentations',
    ...(process.env.STAGE_APP_MAINTAINER ? { maintainer: process.env.STAGE_APP_MAINTAINER } : {}),
    desktop: { entry: { StartupWMClass: 'Stage' } },
  },
};
