import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCTION_ROOTS = ['package.json', 'src', '.github/workflows', 'scripts', 'reviewer-workstation', 'extension-tasks'];
export const EXPERIMENT_GOVERNANCE_VERSION = '1.0.1';

function filesUnder(relative) {
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) return [];
  const entry = { isDirectory: () => false };
  const stat = existsSync(absolute) && readdirSync(path.dirname(absolute), { withFileTypes: true })
    .find((candidate) => candidate.name === path.basename(absolute));
  if (!(stat?.isDirectory?.() ?? entry.isDirectory())) return [relative];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((child) => (
    child.isDirectory() ? filesUnder(path.join(relative, child.name)) : [path.join(relative, child.name)]
  ));
}

export function evaluateExperimentGovernance({
  directoryNames,
  rtmText,
  overrides,
  productionTexts,
  pathExists = () => true,
}) {
  const reasons = [];
  if (overrides?.schema !== 'labview-benchmark-actor/experiment-governance-overrides@1') {
    reasons.push('unsupported experiment-governance schema');
  }
  if (overrides?.version !== EXPERIMENT_GOVERNANCE_VERSION) {
    reasons.push('experiment-governance version drifted');
  }
  const definitions = overrides?.overrides ?? {};
  const names = [...directoryNames].sort();
  const inventory = [];

  for (const name of names) {
    const rtmGoverned = rtmText.includes(`experiments/${name}/`);
    const override = definitions[name];
    if (rtmGoverned && override) reasons.push(`${name} is RTM-governed and must not have an override`);
    if (!rtmGoverned && !override) {
      reasons.push(`${name} is not referenced by the RTM and has no lifecycle override`);
      continue;
    }
    if (rtmGoverned) {
      inventory.push({ name, status: 'active', productionUse: 'governed', source: 'rtm' });
      continue;
    }

    if (!['active', 'prototype', 'superseded', 'retired'].includes(override.status)) {
      reasons.push(`${name} has invalid lifecycle status`);
    }
    if (!Array.isArray(override.requirements) || override.requirements.length === 0
        || override.requirements.some((requirement) => !rtmText.includes(requirement))) {
      reasons.push(`${name} has unresolved requirement ownership`);
    }
    if (typeof override.owner !== 'string' || !override.owner) reasons.push(`${name} has no owner`);

    const marker = `experiments/${name}`;
    const productionReferences = Object.entries(productionTexts)
      .filter(([, content]) => content.includes(marker))
      .map(([file]) => file);

    if (override.status === 'active') {
      if (!['allowed', 'evidence-only'].includes(override.productionUse)) {
        reasons.push(`${name} active experiment has invalid productionUse`);
      }
      if (override.productionUse === 'allowed') {
        if (!Array.isArray(override.productionSurfaces) || override.productionSurfaces.length === 0) {
          reasons.push(`${name} allows production use without named surfaces`);
        } else {
          for (const surface of override.productionSurfaces) {
            if (!pathExists(surface) || !productionTexts[surface]?.includes(marker)) {
              reasons.push(`${name} production surface does not resolve or reference the experiment: ${surface}`);
            }
          }
        }
      } else if (productionReferences.length) {
        reasons.push(`${name} evidence-only experiment is referenced by production: ${productionReferences.join(',')}`);
      }
    } else {
      if (override.productionUse !== 'prohibited') reasons.push(`${name} non-active experiment must prohibit production use`);
      if (typeof override.exitCriteria !== 'string' || !override.exitCriteria) reasons.push(`${name} lacks exit criteria`);
      if (productionReferences.length) {
        reasons.push(`${name} ${override.status} experiment is referenced by production: ${productionReferences.join(',')}`);
      }
      if (override.status === 'superseded' && (!override.supersededBy || !pathExists(override.supersededBy))) {
        reasons.push(`${name} superseded replacement does not resolve`);
      }
    }
    inventory.push({ name, ...override, source: 'override', productionReferences });
  }

  for (const name of Object.keys(definitions)) {
    if (!names.includes(name)) reasons.push(`override names missing experiment directory: ${name}`);
  }
  const prototypes = inventory.filter((item) => item.status === 'prototype').length;
  const superseded = inventory.filter((item) => item.status === 'superseded').length;
  const forbiddenProductionReferences = inventory
    .filter((item) => ['prototype', 'superseded', 'retired'].includes(item.status))
    .reduce((sum, item) => sum + (item.productionReferences?.length ?? 0), 0);
  return {
    ok: reasons.length === 0,
    reasons,
    inventory,
    kpi: {
      total: names.length,
      governed: inventory.length,
      ungoverned: names.length - inventory.length,
      prototypes,
      superseded,
      forbiddenProductionReferences,
    },
  };
}

export function loadExperimentGovernance() {
  const directoryNames = readdirSync(path.join(root, 'experiments'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const productionFiles = PRODUCTION_ROOTS.flatMap(filesUnder);
  return evaluateExperimentGovernance({
    directoryNames,
    rtmText: readFileSync(path.join(root, 'docs', 'requirements', 'rtm.csv'), 'utf8'),
    overrides: JSON.parse(readFileSync(path.join(root, 'experiments', 'governance-overrides.json'), 'utf8')),
    productionTexts: Object.fromEntries(productionFiles.map((file) => [
      file.replaceAll('\\', '/'),
      readFileSync(path.join(root, file), 'utf8'),
    ])),
    pathExists: (relative) => existsSync(path.join(root, relative)),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = loadExperimentGovernance();
  if (!result.ok) {
    for (const reason of result.reasons) console.error(`experiment-governance: FAIL: ${reason}`);
    process.exitCode = 1;
  } else {
    console.log(
      `experiment-governance: PASS ${result.kpi.governed}/${result.kpi.total} governed; `
      + `${result.kpi.ungoverned} ungoverned; `
      + `${result.kpi.forbiddenProductionReferences} forbidden production references; `
      + `${result.kpi.prototypes} prototype; ${result.kpi.superseded} superseded`
    );
  }
}
