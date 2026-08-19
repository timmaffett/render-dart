// Locating or fetching a Dart SDK.
//
// Deliberately free of Render specifics -- this is the piece worth extracting
// into a general Dart/Node bridge if one is ever wanted.

const { execFileSync, spawnSync } = require('node:child_process');
const { createWriteStream } = require('node:fs');
const { mkdir, rm, stat } = require('node:fs/promises');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');

const ARCHIVE_BASE =
  'https://storage.googleapis.com/dart-archive/channels/stable/release';

/**
 * Where a vendored SDK is unpacked, relative to the project root.
 *
 * Inside node_modules on purpose. Render's build cache preserves node_modules
 * between builds but not an arbitrary top-level directory -- measured: with
 * the SDK at `<root>/.dart-sdk` it was re-downloaded on every build, 33s of a
 * 52s build. Moved here, later builds reuse it and the build step drops to
 * about a second. A dot-prefixed directory survives `npm install`.
 */
const VENDOR_DIR = path.join('node_modules', '.dart-sdk');

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function onPath(bin) {
  return spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0;
}

/** The archive URL for a version on this platform. */
function archiveUrl(version) {
  const os = { linux: 'linux', darwin: 'macos', win32: 'windows' }[
    process.platform
  ];
  const arch = { x64: 'x64', arm64: 'arm64' }[process.arch];
  if (!os || !arch) {
    throw new Error(
      `No Dart SDK build for ${process.platform}/${process.arch}.`,
    );
  }
  return `${ARCHIVE_BASE}/${version}/sdk/dartsdk-${os}-${arch}-release.zip`;
}

/** Downloads and unpacks a pinned SDK, returning the path to its `dart`. */
async function fetchSdk({ root, version, log }) {
  const dir = path.join(root, VENDOR_DIR);
  const zip = path.join(root, 'node_modules', '.dart-sdk.zip');
  const url = archiveUrl(version);

  log(`fetching Dart ${version} (${url.split('/').pop()})`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Dart SDK download failed: ${res.status} ${url}`);

  await mkdir(path.dirname(zip), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));

  log('unpacking');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  // The archive has a top-level `dart-sdk/`; unpack into a parent and point
  // at the inner directory rather than trying to strip it.
  execFileSync('unzip', ['-q', zip, '-d', dir], { stdio: 'inherit' });
  await rm(zip, { force: true });

  return path.join(dir, 'dart-sdk', 'bin', 'dart');
}

/**
 * Finds a usable `dart`, in the order that keeps each environment fast:
 *
 *   1. a previously vendored SDK  (Render, second build onward)
 *   2. `dart` on PATH            (a laptop, or CI using setup-dart)
 *   3. download a pinned SDK     (Render's Node builder, first build)
 */
async function resolveDart({ root, version, log }) {
  const vendored = path.join(root, VENDOR_DIR, 'dart-sdk', 'bin', 'dart');
  if (await exists(vendored)) {
    log('using vendored Dart SDK (cache hit)');
    return vendored;
  }
  if (onPath('dart')) {
    log('using Dart from PATH');
    return 'dart';
  }
  return fetchSdk({ root, version, log });
}

module.exports = { resolveDart, fetchSdk, archiveUrl, VENDOR_DIR };
