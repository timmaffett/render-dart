// Deciding *which* Dart to use, separately from finding or fetching one.
//
// Kept apart from dart-sdk.js because the questions are different: this file
// answers "what did the user ask for", that one answers "where is it". Mixing
// them is how the pin came to be consulted only on the download path.

const CHANNELS = ['stable', 'beta', 'dev'];

/** The version this package installs when nobody has asked for one. */
const DEFAULT_DART_VERSION = '3.13.0';

const ARCHIVE = 'https://storage.googleapis.com/dart-archive/channels';

/**
 * What the user asked for, and how firmly.
 *
 * `explicit` is the important part. A pin someone typed has to be honoured even
 * when a different Dart is already on PATH, or it is not a pin. The built-in
 * default has no such claim: it exists so a first build on Render has something
 * to fetch, and deferring to a local toolchain there is a courtesy, not a bug.
 *
 * Precedence, highest first: the command line, the environment, package.json.
 * The flag is for trying something once, the environment for varying a build
 * without a commit — Render's dashboard sets those — and package.json for the
 * answer that should travel with the project.
 */
function requestedVersion({ flag, env, config }) {
  if (flag) return { version: flag, explicit: true, from: '--dart-version' };
  if (env) return { version: env, explicit: true, from: 'RENDER_DART_VERSION' };
  if (config) return { version: config, explicit: true, from: 'package.json' };
  return { version: DEFAULT_DART_VERSION, explicit: false, from: 'default' };
}

/** Whether a request names a moving target rather than one release. */
function isAlias(version) {
  return version === 'latest' || CHANNELS.includes(version);
}

/**
 * Turns `latest` or a channel name into the version it currently means.
 *
 * An exact version resolves to itself without touching the network, so a
 * pinned project keeps building when the archive is unreachable — which is the
 * main practical argument for pinning one.
 */
async function resolveVersion(version, { log = () => {} } = {}) {
  if (!isAlias(version)) return version;

  const channel = version === 'latest' ? 'stable' : version;
  const url = `${ARCHIVE}/${channel}/release/latest/VERSION`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Could not resolve Dart "${version}": ${res.status} from ${url}`,
    );
  }
  const { version: resolved } = await res.json();
  log(`"${version}" is Dart ${resolved} today`);
  return resolved;
}

/**
 * Every version the archive offers on a channel, newest first.
 *
 * The bucket lists build-number directories alongside version ones — 28 against
 * 176 on stable — so anything without a dot is dropped.
 */
async function listVersions(channel = 'stable') {
  if (!CHANNELS.includes(channel)) {
    throw new Error(
      `Unknown channel "${channel}". Choose one of: ${CHANNELS.join(', ')}.`,
    );
  }
  const url =
    'https://storage.googleapis.com/storage/v1/b/dart-archive/o' +
    `?delimiter=/&prefix=channels/${channel}/release/&fields=prefixes`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not list Dart versions: ${res.status}`);
  const { prefixes = [] } = await res.json();

  return prefixes
    .map((p) => p.split('/').filter(Boolean).pop())
    .filter((name) => name.includes('.'))
    .sort(compareVersions)
    .reverse();
}

/** Numeric where both are numeric, so 3.9.0 sorts below 3.10.0. */
function compareVersions(a, b) {
  const parts = (v) => v.split(/[.\-+]/).map((n) => (/^\d+$/.test(n) ? +n : n));
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const [p, q] = [x[i], y[i]];
    if (p === q) continue;
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (typeof p === typeof q) return p < q ? -1 : 1;
    // A pre-release suffix sorts below the plain release it belongs to.
    return typeof p === 'number' ? 1 : -1;
  }
  return 0;
}

module.exports = {
  CHANNELS,
  DEFAULT_DART_VERSION,
  requestedVersion,
  isAlias,
  resolveVersion,
  listVersions,
  compareVersions,
};
