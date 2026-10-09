import fs from "node:fs";
import path from "node:path";
import {
  TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD,
  TASK_COMPILE_SOLIDITY_RUN_SOLC,
  TASK_COMPILE_SOLIDITY_RUN_SOLCJS,
} from "hardhat/builtin-tasks/task-names.js";
import type { HardhatRuntimeEnvironment } from "hardhat/types/index.js";
import {
  assertUpgradeSafe,
  getContractVersion,
  getStorageLayout,
  getStorageUpgradeReport,
  makeNamespacedInput,
  solcInputOutputDecoder,
  trySanitizeNatSpec,
  validate,
  withValidationDefaults,
  type SolcInput,
  type SolcOutput,
  type ValidationOptions,
  type ValidationRunData,
} from "@openzeppelin/upgrades-core";
import { importClosure } from "./closure.js";
import {
  describeNamespace,
  isConsistent,
  namespacesOf,
  renameAnnotations,
  type AnnotationRename,
} from "./namespaces.js";

export { erc7201 } from "./namespaces.js";

/** ERC-1967 implementation slot, see `ERC1967Utils.sol` */
export const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

// Saved inputs carry their tool's outputSelection, which may lack storageLayout, so every compile sets its own
const OUTPUT_SELECTION = {
  "*": {
    "*": [
      "storageLayout",
      "evm.bytecode.object",
      "evm.bytecode.linkReferences",
      "evm.deployedBytecode.object",
      "evm.deployedBytecode.immutableReferences",
      "evm.methodIdentifiers",
    ],
    "": ["ast"],
  },
};

type ImmutableReferences = Record<string, { start: number; length: number }[]>;

// upgrades-core's SolcOutput type omits the deployed bytecode that OUTPUT_SELECTION asks solc for
type SolcEvmWithDeployedBytecode = SolcOutput["contracts"][string][string]["evm"] & {
  deployedBytecode?: { object: string; immutableReferences?: ImmutableReferences };
};

interface Compilation {
  id: string;
  input: SolcInput;
  output: SolcOutput;
  solcVersion: string;
}

export interface UpgradeSafetyOptions {
  /** Default "uups" */
  kind?: ValidationOptions["kind"];
  /** OZ checks to waive for the new implementation, e.g. ["missing-initializer"]. Never affects the storage check. */
  unsafeAllow?: ValidationOptions["unsafeAllow"];
  /**
   * Network whose `deployments/<network>/solcInputs` hold the live source. Defaults to `hre.network.name`; set it on a
   * fork run as `hardhat` whose deployments were not copied (e.g. `--release ethereum`).
   */
  deploymentsNetwork?: string;
}

export interface UpgradeSafetyResult {
  ok: boolean;
  liveImplementation: string;
  /** Fully qualified name of the live implementation's source, e.g. `src/Gateway.sol:Gateway @ <solcInputHash>` */
  reference: string;
  /** Why the upgrade is unsafe; empty when `ok` */
  report: string;
  /** Corrections applied to the live source's annotations, each justified by the slot constant it actually uses */
  notes: string[];
}

// Compiles are slow and the same inputs are checked once per proxy, so cache them per process
const compilations = new Map<string, Promise<Compilation>>();
const validations = new Map<string, Promise<ValidationRunData>>();

const runSolc = async (hre: HardhatRuntimeEnvironment, input: SolcInput, solcVersion: string): Promise<SolcOutput> => {
  const build = (await hre.run(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, { quiet: true, solcVersion })) as {
    isSolcJs: boolean;
    compilerPath: string;
  };
  const output = (await (build.isSolcJs
    ? hre.run(TASK_COMPILE_SOLIDITY_RUN_SOLCJS, { input, solcJsPath: build.compilerPath })
    : hre.run(TASK_COMPILE_SOLIDITY_RUN_SOLC, { input, solcPath: build.compilerPath, solcVersion }))) as SolcOutput;
  const errors = (output.errors ?? []).filter(e => e.severity === "error");
  if (errors.length) throw new Error(`solc ${solcVersion} failed:\n${errors.map(e => e.formattedMessage).join("\n")}`);
  return output;
};

/** Compiles `input` with the outputs needed to match bytecode and read storage. `id` keys the cache. */
const compile = (hre: HardhatRuntimeEnvironment, rawInput: SolcInput, solcVersion: string, id: string) => {
  const key = `${solcVersion}:${id}`;
  let compilation = compilations.get(key);
  if (!compilation) {
    const input = { ...rawInput, settings: { ...rawInput.settings, outputSelection: OUTPUT_SELECTION } } as SolcInput;
    compilation = runSolc(hre, input, solcVersion).then(output => ({ id, input, output, solcVersion }));
    compilations.set(key, compilation);
  }
  return compilation;
};

/**
 * Runs the OZ validations on a compilation. Namespaced (ERC-7201) structs are not part of solc's storage layout, so like
 * hardhat-upgrades we also compile a namespaced variant of the input to extract their layout. That second compile is
 * only paid for compilations actually compared, not for every candidate tried as a match.
 */
const validateCompilation = (hre: HardhatRuntimeEnvironment, { id, input, output, solcVersion }: Compilation) => {
  const key = `${solcVersion}:${id}`;
  let validation = validations.get(key);
  if (!validation) {
    validation = (async () => {
      const namespacedInput = await trySanitizeNatSpec(makeNamespacedInput(input, output, solcVersion), solcVersion);
      const namespacedOutput = await runSolc(hre, namespacedInput, solcVersion);
      return validate(output, solcInputOutputDecoder(input, output), solcVersion, input, namespacedOutput);
    })();
    validations.set(key, validation);
  }
  return validation;
};

// Live code has immutables filled in where the compiled code has zeros, so mask them out before comparing
const maskImmutables = (code: string, immutableReferences: ImmutableReferences = {}) => {
  let masked = code;
  for (const refs of Object.values(immutableReferences)) {
    for (const { start, length } of refs) {
      masked = masked.slice(0, start * 2) + "0".repeat(length * 2) + masked.slice((start + length) * 2);
    }
  }
  return masked;
};

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));

interface Artifact {
  address?: string;
  implementation?: string;
  solcInputHash?: string;
  metadata?: string;
}

/**
 * Saved solc inputs, most likely first, each with the solc versions to try. An input does not record its compiler; an
 * artifact that used it does, but upgrades overwrite artifacts, so an input may have none left: then fall back to the
 * versions this project compiles with. Inputs of artifacts that record `implementation` go first, since they usually
 * hold its source. Artifacts can name a different build than the one live, so this only orders the search.
 */
const candidates = (hre: HardhatRuntimeEnvironment, deploymentsDir: string, implementation: string) => {
  const solcInputsDir = path.join(deploymentsDir, "solcInputs");
  if (!fs.existsSync(solcInputsDir)) throw new Error(`Missing ${solcInputsDir}; copy the network's deployments first`);

  const versions = new Map<string, string>();
  const hinted = new Set<string>();
  for (const file of fs.readdirSync(deploymentsDir).filter(f => f.endsWith(".json"))) {
    const artifact = readJson(path.join(deploymentsDir, file)) as Artifact;
    if (!artifact.solcInputHash) continue;
    if ([artifact.address, artifact.implementation].some(a => a?.toLowerCase() === implementation)) {
      hinted.add(artifact.solcInputHash);
    }
    if (!artifact.metadata || versions.has(artifact.solcInputHash)) continue;
    const version = (JSON.parse(artifact.metadata) as { compiler?: { version?: string } }).compiler?.version;
    if (version) versions.set(artifact.solcInputHash, version.split("+")[0] ?? version);
  }

  const { compilers, overrides } = hre.config.solidity;
  const fallback = [...new Set([...compilers, ...Object.values(overrides)].map(c => c.version))];
  const ids = fs
    .readdirSync(solcInputsDir)
    .filter(f => f.endsWith(".json"))
    .map(f => f.slice(0, -".json".length))
    .sort((a, b) => Number(hinted.has(b)) - Number(hinted.has(a)));
  return ids.map(id => {
    const known = versions.get(id);
    // The bytecode embeds the compiler version, so no other version could match
    return { id, file: path.join(solcInputsDir, `${id}.json`), solcVersions: known ? [known] : fallback };
  });
};

interface LiveImplementation {
  implementation: string;
  compilation: Compilation;
  fullyQualifiedName: string;
  solcInputHash: string;
}

// Proxies share implementations, so resolve each once
const liveImplementations = new Map<string, Promise<LiveImplementation>>();

/**
 * Finds the source of the implementation currently behind `proxy` by recompiling every solc input that
 * hardhat-deploy recorded for the network and matching the result against the live bytecode. Matching on bytecode
 * (rather than trusting artifact names) guarantees the storage layout we compare against is the one actually live.
 */
const findLiveImplementation = async (
  hre: HardhatRuntimeEnvironment,
  proxy: string,
  deploymentsNetwork: string,
  root: string,
) => {
  const slot = (await hre.network.provider.request({
    method: "eth_getStorageAt",
    params: [proxy, IMPLEMENTATION_SLOT, "latest"],
  })) as string;
  const implementation = `0x${slot.slice(-40)}`.toLowerCase();
  const key = `${deploymentsNetwork}:${implementation}`;
  let live = liveImplementations.get(key);
  if (!live) {
    const deploymentsDir = path.join(hre.config.paths.root, "deployments", deploymentsNetwork);
    live = resolveSource(hre, implementation, deploymentsDir, root);
    liveImplementations.set(key, live);
  }
  return live;
};

const resolveSource = async (
  hre: HardhatRuntimeEnvironment,
  implementation: string,
  deploymentsDir: string,
  root: string,
): Promise<LiveImplementation> => {
  const code = (await hre.network.provider.request({
    method: "eth_getCode",
    params: [implementation, "latest"],
  })) as string;
  const liveCode = code.slice(2).toLowerCase();
  if (!liveCode.length) throw new Error(`No code at live implementation ${implementation}`);

  const compileErrors: string[] = [];
  const saved = candidates(hre, deploymentsDir, implementation);
  // First only `root` and its imports from each input that has it; then whole inputs, for a live contract that lives
  // in another file (e.g. under an older name)
  for (const pruned of [true, false]) {
    for (const { id, file, solcVersions } of saved) {
      const full = readJson(file) as SolcInput;
      const input = pruned ? importClosure(full, root) : full;
      if (!input) continue;
      for (const solcVersion of solcVersions) {
        let compilation: Compilation;
        try {
          compilation = await compile(hre, input, solcVersion, pruned ? `${id}#${root}` : id);
        } catch (error) {
          // Expected for a wrong compiler (pragma mismatch), but keep the error in case it was the right one. A pruned
          // compile can also fail for an import the scan missed; the whole input is tried next, so only its error counts
          if (!pruned) compileErrors.push(`${id} with solc ${solcVersion}: ${(error as Error).message}`);
          continue;
        }
        for (const [sourceName, contracts] of Object.entries(compilation.output.contracts)) {
          for (const [contractName, contract] of Object.entries(contracts)) {
            const deployed = (contract.evm as SolcEvmWithDeployedBytecode).deployedBytecode;
            if (!deployed?.object || deployed.object.length !== liveCode.length) continue;
            if (maskImmutables(liveCode, deployed.immutableReferences) === deployed.object.toLowerCase()) {
              const fullyQualifiedName = `${sourceName}:${contractName}`;
              return { implementation, compilation, fullyQualifiedName, solcInputHash: id };
            }
          }
        }
      }
    }
  }
  throw new Error(
    `No solc input in ${path.join(deploymentsDir, "solcInputs")} compiles to the live implementation ` +
      `${implementation}. Refusing to treat the upgrade as safe without the live source.` +
      (compileErrors.length ? `\nCompiles that failed:\n${compileErrors.join("\n")}` : ""),
  );
};

/**
 * Compares the implementation currently behind `proxy` with `contract` from this project's latest compile, using the
 * same checks as OZ's `validateUpgrade`: the new implementation must be upgrade safe, and its storage layout
 * (including ERC-7201 namespaces) must be compatible with the live one. OZ takes each namespace's slot from its
 * annotation, so this also checks every annotation against the slot constant the code actually uses.
 */
export const checkUpgradeSafety = async (
  hre: HardhatRuntimeEnvironment,
  proxy: string,
  contract: string,
  { kind = "uups", unsafeAllow, deploymentsNetwork = hre.network.name }: UpgradeSafetyOptions = {},
): Promise<UpgradeSafetyResult> => {
  const opts = withValidationDefaults(unsafeAllow ? { kind, unsafeAllow } : { kind });

  const { sourceName, contractName } = await hre.artifacts.readArtifact(contract);
  const live = await findLiveImplementation(hre, proxy, deploymentsNetwork, sourceName);
  const newFullyQualifiedName = `${sourceName}:${contractName}`;
  const buildInfo = await hre.artifacts.getBuildInfo(newFullyQualifiedName);
  if (!buildInfo) throw new Error(`No build info for ${newFullyQualifiedName}; compile first`);
  const { input: fullInput, solcVersion, id } = buildInfo;
  const prunedInput = importClosure(fullInput, sourceName);
  const updatedCompilation = await (prunedInput
    ? compile(hre, prunedInput, solcVersion, `${id}#${sourceName}`).catch(() =>
        compile(hre, fullInput, solcVersion, id),
      )
    : compile(hre, fullInput, solcVersion, id));
  const updated = await validateCompilation(hre, updatedCompilation);

  const reference = `${live.fullyQualifiedName} @ ${live.solcInputHash}`;
  const problems: string[] = [];
  const notes: string[] = [];

  // The new code must use the slot its annotations claim, or OZ would compare the wrong layout
  const updatedNamespaces = namespacesOf(updatedCompilation.input, updatedCompilation.output, newFullyQualifiedName);
  for (const ns of updatedNamespaces.filter(n => !isConsistent(n))) {
    problems.push(`Namespace slot mismatch in ${contractName}: ${describeNamespace(ns)}`);
  }

  // A live annotation that disagrees with its constant is corrected from the constant, the slot actually in use, but
  // only to the id the new code declares for the same struct; anything else can't be verified
  const renames: AnnotationRename[] = [];
  for (const ns of namespacesOf(live.compilation.input, live.compilation.output, live.fullyQualifiedName)) {
    if (isConsistent(ns)) continue;
    const values = ns.constants.map(c => c.value);
    const match = updatedNamespaces.find(
      u => u.contract === ns.contract && u.struct === ns.struct && values.includes(u.annotated),
    );
    if (!match) {
      problems.push(`Live implementation cannot be verified: ${describeNamespace(ns)}`);
      continue;
    }
    renames.push({ sourceName: ns.sourceName, from: ns.id, to: match.id });
    notes.push(`live ${ns.contract}.${ns.struct} is annotated erc7201:${ns.id}, but its slot is erc7201:${match.id}`);
  }
  const { compilation } = live;
  const original = await validateCompilation(
    hre,
    renames.length
      ? await compile(
          hre,
          renameAnnotations(compilation.input, renames),
          compilation.solcVersion,
          `${compilation.id}:${renames.map(r => `${r.from}>${r.to}`).join(",")}`,
        )
      : compilation,
  );

  try {
    assertUpgradeSafe([updated], getContractVersion(updated, newFullyQualifiedName), opts);
  } catch (error) {
    problems.push((error as Error).message);
  }

  const originalLayout = getStorageLayout([original], getContractVersion(original, live.fullyQualifiedName));
  const updatedLayout = getStorageLayout([updated], getContractVersion(updated, newFullyQualifiedName));
  const storageReport = getStorageUpgradeReport(originalLayout, updatedLayout, opts);
  if (!storageReport.ok) problems.push(storageReport.explain());

  return {
    ok: problems.length === 0,
    liveImplementation: live.implementation,
    reference,
    report: problems.join("\n\n"),
    notes,
  };
};

/** `checkUpgradeSafety`, throwing with the report when the upgrade is unsafe. */
export const assertUpgradeSafety = async (
  hre: HardhatRuntimeEnvironment,
  proxy: string,
  contract: string,
  options?: UpgradeSafetyOptions,
): Promise<UpgradeSafetyResult> => {
  const result = await checkUpgradeSafety(hre, proxy, contract, options);
  if (!result.ok) {
    throw new Error(`Upgrade of ${proxy} from ${result.reference} to ${contract} is unsafe:\n${result.report}`);
  }
  return result;
};
