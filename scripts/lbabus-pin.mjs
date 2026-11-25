// The one place that knows how this repository consumes lbabus: only as the release pinned in
// release-components.json (`lbabusRelease`). The pure checks here back the `lbabus-pin-matches-agents-contract`
// gate and the fetch helper (scripts/fetch-lbabus.mjs).

export const LBABUS_REPOSITORY = 'https://github.com/svelderrainruiz/lbabus';

const hex = (value, length) => typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value);

export function expectedAssetNames(version) {
  return {
    package: `LabViewBenchmarkActor.CollabBus.${version}.nupkg`,
    'linux-x64': `lbabus-${version}-linux-x64`,
    'win-x64': `lbabus-${version}-win-x64.exe`,
    sums: 'SHA256SUMS',
  };
}

/** Returns the reasons the pin is unusable; an empty list means it is well-formed. */
export function pinProblems(components) {
  const reasons = [];
  const pin = components?.lbabusRelease;
  const version = components?.lbabus;
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) reasons.push('release-components.json has no valid lbabus version');
  if (pin?.repository !== LBABUS_REPOSITORY) reasons.push('lbabusRelease must name the svelderrainruiz/lbabus repository');
  if (pin?.tag !== `v${version}`) reasons.push('lbabusRelease tag does not match the lbabus version');
  if (!hex(pin?.tagObject, 40) || !hex(pin?.commit, 40)) reasons.push('lbabusRelease must pin the tag object and commit as 40-hex SHA-1');
  const names = Object.values(expectedAssetNames(version));
  const pinned = Object.keys(pin?.assets ?? {});
  if (pinned.length !== names.length || names.some((name) => !hex(pin?.assets?.[name], 64))) {
    reasons.push('lbabusRelease must pin exactly the package, both binaries and SHA256SUMS by SHA-256');
  }
  return reasons;
}

/**
 * The pin-vs-AGENTS-contract gate: the pin is well-formed, the extension's AGENTS contract names the pinned
 * version, every consumer default repeats the pinned tag and commit, and no in-tree copy of lbabus remains.
 * `consumers` is a list of { name, tag, commit } read from the files that carry a default.
 */
export function verifyPinContract({ components, agentsText, consumers, inTreeCopyPaths }) {
  const reasons = pinProblems(components);
  const pin = components?.lbabusRelease;
  if (!String(agentsText ?? '').includes(`exactly \`${components?.lbabus}\` for this extension build`)) {
    reasons.push(`the extension AGENTS contract does not name the pinned lbabus ${components?.lbabus}`);
  }
  for (const consumer of consumers ?? []) {
    if (consumer.tag !== pin?.tag) reasons.push(`${consumer.name} pins tag ${consumer.tag}, not ${pin?.tag}`);
    if (consumer.commit !== pin?.commit) reasons.push(`${consumer.name} pins commit ${consumer.commit}, not ${pin?.commit}`);
  }
  for (const path of inTreeCopyPaths ?? []) reasons.push(`the in-tree lbabus copy must be gone: ${path} exists`);
  return { ok: reasons.length === 0, reasons };
}
