// Locating or fetching a Dart SDK.
//
// Deliberately free of Render specifics -- this is the piece worth extracting
// into a general Dart/Node bridge if one is ever wanted.

const { createHash } = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { createWriteStream } = require('node:fs');
const { mkdir, readFile, rm, stat, writeFile } = require('node:fs/promises');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');

const { resolveVersion } = require('./dart-version');

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

/**
 * The version of a `dart` executable, or null if it will not say.
 *
 * `dart --version` writes to stderr on some releases and stdout on others, so
 * both are searched rather than assuming either.
 */
function versionOf(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const m = `${r.stdout ?? ''}${r.stderr ?? ''}`.match(/Dart SDK version:\s*(\S+)/);
  return m ? m[1] : null;
}

/** The version recorded beside a vendored SDK, if one was written. */
async function vendoredVersion(root) {
  try {
    return (await readFile(path.join(root, VENDOR_DIR, 'VERSION'), 'utf8')).trim();
  } catch {
    return null;
  }
}

/** The published checksum for an archive, or null if none is served. */
async function publishedChecksum(url) {
  const res = await fetch(`${url}.sha256sum`);
  if (!res.ok) return null;
  // The file is "<hex> *<filename>".
  const [hex] = (await res.text()).trim().split(/\s+/);
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
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
  const [res, expected] = await Promise.all([
    fetch(url),
    publishedChecksum(url),
  ]);
  if (!res.ok) throw new Error(`Dart SDK download failed: ${res.status} ${url}`);

  await mkdir(path.dirname(zip), { recursive: true });

  // Hashed while it streams to disk rather than in a second pass: the bytes are
  // already going through this process, so verifying costs no extra I/O and
  // overlaps the download. Measured at 0.18s of CPU for a 228 MB archive,
  // against roughly 30s to fetch it.
  const hash = createHash('sha256');
  await pipeline(
    Readable.fromWeb(res.body),
    async function* (source) {
      for await (const chunk of source) {
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(zip),
  );

  if (expected) {
    const actual = hash.digest('hex');
    if (actual !== expected) {
      await rm(zip, { force: true });
      throw new Error(
        `Dart SDK checksum mismatch for ${version}.\n` +
          `  expected ${expected}\n  received ${actual}\n` +
          'The archive was not unpacked. This is worth reporting rather than ' +
          'retrying: the SDK is downloaded over the network and then executed.',
      );
    }
    log('checksum verified');
  } else {
    // Older releases predate the published sums; say so rather than implying a
    // check happened.
    log(`no published checksum for ${version}; skipping verification`);
  }

  log('unpacking');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  // The archive has a top-level `dart-sdk/`; unpack into a parent and point
  // at the inner directory rather than trying to strip it.
  execFileSync('unzip', ['-q', zip, '-d', dir], { stdio: 'inherit' });
  await rm(zip, { force: true });

  // Recorded so the next build can tell *which* SDK is cached. Without this the
  // cache key is "does the directory exist", and changing the pin has no effect
  // on any machine that has already built once — including every Render build
  // after the first.
  await writeFile(path.join(dir, 'VERSION'), `${version}\n`);

  return path.join(dir, 'dart-sdk', 'bin', 'dart');
}

/**
 * Finds a `dart` that satisfies the request, and says where it came from.
 *
 * The order still keeps each environment fast, but a pin now decides rather
 * than merely suggesting:
 *
 *   1. a vendored SDK, if it is the version asked for
 *   2. `dart` on PATH, if it is the version asked for — or if nothing was asked
 *   3. download, unless `fetch` is false — see below
 *
 * The difference from before is the phrase "the version asked for". Previously
 * both caches were consulted by existence alone, so a pinned version was
 * honoured on a first Render build and silently ignored everywhere else: on a
 * laptop PATH always won, and on later Render builds whatever had been vendored
 * first won for ever. That is why setting `dartVersion` appeared to do nothing.
 *
 * A request that is not explicit — the built-in default — still defers to a
 * local toolchain, because that default exists to give a first build something
 * to fetch, not to override a Dart the developer installed deliberately.
 */
async function resolveDart({ root, version, explicit = false, fetch: mayFetch = true, log }) {
  const wanted = await resolveVersion(version, { log });

  const vendored = path.join(root, VENDOR_DIR, 'dart-sdk', 'bin', 'dart');
  if (await exists(vendored)) {
    const have = await vendoredVersion(root);
    if (!explicit || have === wanted) {
      log(`using Dart ${have ?? 'unknown'} (vendored)`);
      return { dart: vendored, version: have, source: 'vendored' };
    }
    log(`vendored Dart is ${have ?? 'unknown'}, ${wanted} was asked for`);
  }

  if (onPath('dart')) {
    const have = versionOf('dart');
    if (!explicit || have === wanted) {
      log(`using Dart ${have ?? 'unknown'} from PATH`);
      return { dart: 'dart', version: have, source: 'path' };
    }
    log(`Dart on PATH is ${have ?? 'unknown'}, ${wanted} was asked for`);
  }

  if (!mayFetch) {
    // Asking which Dart would be used must not install one. `render-dart dart`
    // is a question, and a question that pulls 228 MB and unpacks 624 MB is a
    // surprise nobody asked for.
    return { dart: null, version: wanted, source: 'would download' };
  }

  const dart = await fetchSdk({ root, version: wanted, log });
  log(`using Dart ${wanted} (downloaded)`);
  return { dart, version: wanted, source: 'downloaded' };
}

module.exports = {
  resolveDart,
  fetchSdk,
  archiveUrl,
  versionOf,
  vendoredVersion,
  publishedChecksum,
  VENDOR_DIR,
};
