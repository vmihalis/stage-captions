import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

// Run on macOS after packaging:
// node tests/desktop/mac-distribution-check.mjs <Stage.app> <installer.dmg> <installer.zip>
// This checks packaged integrity without launching Stage or requesting a microphone.
// Ad-hoc signatures are not Developer ID signatures and do not establish Gatekeeper acceptance.
// A future Developer ID + notarized release must set STAGE_REQUIRE_NOTARIZATION=1.
assert.equal(process.platform, 'darwin', 'Mac distribution verification must run on macOS.');
const [appArgument, dmgArgument, zipArgument, ...extraArguments] = process.argv.slice(2);
assert.ok(appArgument && dmgArgument && zipArgument && extraArguments.length === 0,
  'Pass the packaged Stage.app, its DMG, and its ZIP.');
const app = resolve(appArgument);
const dmg = resolve(dmgArgument);
const zip = resolve(zipArgument);
const config = createRequire(import.meta.url)('../../electron-builder.config.cjs');
const packageJson = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
const requireNotarization = process.env.STAGE_REQUIRE_NOTARIZATION === '1';
assert.ok(config.appId && config.productName && packageJson.version, 'Package identity must be configured.');
const execute = promisify(execFile);

async function command(executable, args) {
  try {
    return await execute(executable, args, { timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`${executable} failed: ${[error.stdout, error.stderr, error.message].filter(Boolean).join('\n')}`,
      { cause: error });
  }
}

async function verifyApp(bundle, label) {
  console.log(`Checking ${label}...`);
  const plist = join(bundle, 'Contents', 'Info.plist');
  for (const [key, expected] of [
    ['CFBundleIdentifier', config.appId],
    ['CFBundleShortVersionString', packageJson.version],
    ['CFBundleExecutable', config.productName],
  ]) {
    const { stdout } = await command('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist]);
    assert.equal(stdout.trim(), expected, `${label}: unexpected ${key}.`);
  }
  await command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle]);
  const display = await command('/usr/bin/codesign', ['--display', '--verbose=4', bundle]);
  const signature = `${display.stdout}\n${display.stderr}`;
  assert.equal(signature.match(/^Identifier=(.+)$/m)?.[1], config.appId,
    `${label}: the code-signing identifier must match Stage's bundle identifier.`);
  assert.match(signature, /^Sealed Resources version=/m,
    `${label}: the app must have a resource seal covering its packaged contents.`);
  if (requireNotarization) {
    assert.match(signature, /^Authority=Developer ID Application:/m,
      `${label}: notarized releases require a Developer ID Application signature.`);
    await command('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', bundle]);
    await command('/usr/bin/xcrun', ['stapler', 'validate', bundle]);
  }
  console.log(`${label}: strict code-signature, resource seal, bundle identity, and version checks passed.`);
}

await verifyApp(app, 'Built app');
await command('/usr/bin/hdiutil', ['verify', dmg]);
console.log('DMG checksum verification passed.');
const temporary = await mkdtemp(join(tmpdir(), 'stage-mac-distribution-'));
const mount = join(temporary, 'mounted-dmg');
let mounted = false;
try {
  await mkdir(mount);
  await command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmg]);
  mounted = true;
  await verifyApp(join(mount, `${config.productName}.app`), 'App inside read-only DMG');
  await command('/usr/bin/hdiutil', ['detach', mount]);
  mounted = false;
  const extracted = join(temporary, 'expanded-zip');
  await command('/usr/bin/ditto', ['-x', '-k', zip, extracted]);
  await verifyApp(join(extracted, `${config.productName}.app`), 'App expanded from ZIP');
} finally {
  // Never recursively remove a temporary path while an installer is still mounted there.
  if (mounted) {
    await command('/usr/bin/hdiutil', ['detach', mount]);
    mounted = false;
  }
  await rm(temporary, { recursive: true, force: true });
}
console.log(requireNotarization
  ? 'Mac distribution passed integrity, Developer ID, Gatekeeper assessment, and stapled notarization checks.'
  : 'Mac distribution integrity passed. Developer ID, notarization, and Gatekeeper acceptance were not verified.');
