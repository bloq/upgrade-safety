"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var src_exports = {};
__export(src_exports, {
  IMPLEMENTATION_SLOT: () => IMPLEMENTATION_SLOT,
  assertUpgradeSafety: () => assertUpgradeSafety,
  checkUpgradeSafety: () => checkUpgradeSafety,
  erc7201: () => erc7201
});
module.exports = __toCommonJS(src_exports);
var import_node_fs = __toESM(require("fs"), 1);
var import_node_path2 = __toESM(require("path"), 1);
var import_task_names = require("hardhat/builtin-tasks/task-names.js");
var import_upgrades_core = require("@openzeppelin/upgrades-core");

// src/closure.ts
var import_node_path = __toESM(require("path"), 1);
var IMPORT = /^\s*import\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gm;
var importClosure = (input, root) => {
  const remappings = input.settings?.remappings;
  if (remappings?.length || !input.sources[root]) return void 0;
  const closure = /* @__PURE__ */ new Set();
  const pending = [root];
  for (let sourceName = pending.pop(); sourceName !== void 0; sourceName = pending.pop()) {
    if (closure.has(sourceName)) continue;
    const content = input.sources[sourceName]?.content;
    if (content === void 0) return void 0;
    closure.add(sourceName);
    for (const [, imported = ""] of content.matchAll(IMPORT)) {
      const resolved = imported.startsWith(".") ? import_node_path.default.posix.normalize(import_node_path.default.posix.join(import_node_path.default.posix.dirname(sourceName), imported)) : imported;
      if (!input.sources[resolved]) return void 0;
      pending.push(resolved);
    }
  }
  const sources = Object.fromEntries(Object.entries(input.sources).filter(([s]) => closure.has(s)));
  return { ...input, sources };
};

// src/namespaces.ts
var import_sha3 = require("@noble/hashes/sha3");
var import_utils = require("@noble/hashes/utils");
var ANNOTATION = /^\s*@custom:storage-location\s+(\S+)/m;
var FORMULA = /^keccak256\(abi\.encode\(uint256\(keccak256\("([^"\\]+)"\)\)-1\)\)&~bytes32\(uint256\(0xff\)\)$/;
var SPACING = /("(?:[^"\\]|\\.)*")|\s+/g;
var WORD = /^0x[0-9a-fA-F]{64}$/;
var toWord = (value) => `0x${value.toString(16).padStart(64, "0")}`;
var erc7201 = (id) => {
  const inner = BigInt(`0x${(0, import_utils.bytesToHex)((0, import_sha3.keccak_256)((0, import_utils.utf8ToBytes)(id)))}`) - 1n;
  const outer = BigInt(`0x${(0, import_utils.bytesToHex)((0, import_sha3.keccak_256)((0, import_utils.hexToBytes)(toWord(inner).slice(2))))}`) & ~0xffn;
  return toWord(outer);
};
var evaluate = (node, source) => {
  if (!node) return void 0;
  if (node.nodeType === "Literal" && node.kind === "number" && node.value && WORD.test(node.value)) {
    return node.value.toLowerCase();
  }
  const [start = 0, length = 0] = node.src.split(":").map(Number);
  const text = source.subarray(start, start + length).toString("utf8").replace(SPACING, (_, literal) => literal ?? "");
  const id = FORMULA.exec(text)?.[1];
  return id === void 0 ? void 0 : erc7201(id);
};
var bytes32Constants = (nodes, source) => nodes.flatMap((n) => {
  if (n.nodeType !== "VariableDeclaration" || !n.constant || n.typeDescriptions?.typeString !== "bytes32") return [];
  const value = evaluate(n.value, source);
  return value === void 0 ? [] : [{ name: n.name ?? "", value }];
});
var namespacesOf = (input, output, fullyQualifiedName) => {
  const contracts = /* @__PURE__ */ new Map();
  for (const [sourceName, { ast }] of Object.entries(output.sources)) {
    for (const node of ast.nodes ?? []) {
      if (node.nodeType === "ContractDefinition") contracts.set(node.id, { node, sourceName });
    }
  }
  const separator = fullyQualifiedName.lastIndexOf(":");
  const targetSource = fullyQualifiedName.slice(0, separator);
  const targetName = fullyQualifiedName.slice(separator + 1);
  const target = [...contracts.values()].find((c) => c.sourceName === targetSource && c.node.name === targetName);
  if (!target) throw new Error(`${fullyQualifiedName} not found in the compilation`);
  const namespaces = [];
  for (const id of target.node.linearizedBaseContracts ?? []) {
    const contract = contracts.get(id);
    if (!contract) continue;
    const { node, sourceName } = contract;
    const content = input.sources[sourceName]?.content;
    if (content === void 0) throw new Error(`No source content for ${sourceName}`);
    const source = Buffer.from(content, "utf8");
    const fileNodes = output.sources[sourceName]?.ast?.nodes ?? [];
    const constants = [...bytes32Constants(node.nodes ?? [], source), ...bytes32Constants(fileNodes, source)];
    for (const struct of (node.nodes ?? []).filter((n) => n.nodeType === "StructDefinition")) {
      const location = ANNOTATION.exec(struct.documentation?.text ?? "")?.[1];
      if (location === void 0) continue;
      if (!location.startsWith("erc7201:")) {
        throw new Error(
          `${node.name ?? ""}.${struct.name ?? ""}: storage location ${location} is not erc7201, so its slot can't be checked`
        );
      }
      const annotation = location.slice("erc7201:".length);
      namespaces.push({
        contract: node.name ?? "",
        struct: struct.name ?? "",
        id: annotation,
        sourceName,
        annotated: erc7201(annotation),
        constants
      });
    }
  }
  return namespaces;
};
var isConsistent = (ns) => ns.constants.some((c) => c.value === ns.annotated);
var describeNamespace = (ns) => `${ns.contract}.${ns.struct}: annotated erc7201:${ns.id} (slot ${ns.annotated}) but its bytes32 constants are ` + (ns.constants.length ? ns.constants.map((c) => `${c.name}=${c.value}`).join(", ") : "none that could be evaluated");
var renameAnnotations = (input, renames) => {
  const sources = { ...input.sources };
  for (const { sourceName, from, to } of renames) {
    const source = sources[sourceName];
    if (source?.content === void 0) throw new Error(`No source content for ${sourceName}`);
    const pattern = new RegExp(`erc7201:${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`, "g");
    sources[sourceName] = { ...source, content: source.content.replace(pattern, `erc7201:${to}`) };
  }
  return { ...input, sources };
};

// src/index.ts
var IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
var OUTPUT_SELECTION = {
  "*": {
    "*": [
      "storageLayout",
      "evm.bytecode.object",
      "evm.bytecode.linkReferences",
      "evm.deployedBytecode.object",
      "evm.deployedBytecode.immutableReferences",
      "evm.methodIdentifiers"
    ],
    "": ["ast"]
  }
};
var compilations = /* @__PURE__ */ new Map();
var validations = /* @__PURE__ */ new Map();
var runSolc = async (hre, input, solcVersion) => {
  const build = await hre.run(import_task_names.TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, { quiet: true, solcVersion });
  const output = await (build.isSolcJs ? hre.run(import_task_names.TASK_COMPILE_SOLIDITY_RUN_SOLCJS, { input, solcJsPath: build.compilerPath }) : hre.run(import_task_names.TASK_COMPILE_SOLIDITY_RUN_SOLC, { input, solcPath: build.compilerPath, solcVersion }));
  const errors = (output.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(`solc ${solcVersion} failed:
${errors.map((e) => e.formattedMessage).join("\n")}`);
  return output;
};
var compile = (hre, rawInput, solcVersion, id) => {
  const key = `${solcVersion}:${id}`;
  let compilation = compilations.get(key);
  if (!compilation) {
    const input = { ...rawInput, settings: { ...rawInput.settings, outputSelection: OUTPUT_SELECTION } };
    compilation = runSolc(hre, input, solcVersion).then((output) => ({ id, input, output, solcVersion }));
    compilations.set(key, compilation);
  }
  return compilation;
};
var validateCompilation = (hre, { id, input, output, solcVersion }) => {
  const key = `${solcVersion}:${id}`;
  let validation = validations.get(key);
  if (!validation) {
    validation = (async () => {
      const namespacedInput = await (0, import_upgrades_core.trySanitizeNatSpec)((0, import_upgrades_core.makeNamespacedInput)(input, output, solcVersion), solcVersion);
      const namespacedOutput = await runSolc(hre, namespacedInput, solcVersion);
      return (0, import_upgrades_core.validate)(output, (0, import_upgrades_core.solcInputOutputDecoder)(input, output), solcVersion, input, namespacedOutput);
    })();
    validations.set(key, validation);
  }
  return validation;
};
var maskImmutables = (code, immutableReferences = {}) => {
  let masked = code;
  for (const refs of Object.values(immutableReferences)) {
    for (const { start, length } of refs) {
      masked = masked.slice(0, start * 2) + "0".repeat(length * 2) + masked.slice((start + length) * 2);
    }
  }
  return masked;
};
var readJson = (file) => JSON.parse(import_node_fs.default.readFileSync(file, "utf8"));
var candidates = (hre, deploymentsDir, implementation) => {
  const solcInputsDir = import_node_path2.default.join(deploymentsDir, "solcInputs");
  if (!import_node_fs.default.existsSync(solcInputsDir)) throw new Error(`Missing ${solcInputsDir}; copy the network's deployments first`);
  const versions = /* @__PURE__ */ new Map();
  const hinted = /* @__PURE__ */ new Set();
  for (const file of import_node_fs.default.readdirSync(deploymentsDir).filter((f) => f.endsWith(".json"))) {
    const artifact = readJson(import_node_path2.default.join(deploymentsDir, file));
    if (!artifact.solcInputHash) continue;
    if ([artifact.address, artifact.implementation].some((a) => a?.toLowerCase() === implementation)) {
      hinted.add(artifact.solcInputHash);
    }
    if (!artifact.metadata || versions.has(artifact.solcInputHash)) continue;
    const version = JSON.parse(artifact.metadata).compiler?.version;
    if (version) versions.set(artifact.solcInputHash, version.split("+")[0] ?? version);
  }
  const { compilers, overrides } = hre.config.solidity;
  const fallback = [...new Set([...compilers, ...Object.values(overrides)].map((c) => c.version))];
  const ids = import_node_fs.default.readdirSync(solcInputsDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length)).sort((a, b) => Number(hinted.has(b)) - Number(hinted.has(a)));
  return ids.map((id) => {
    const known = versions.get(id);
    return { id, file: import_node_path2.default.join(solcInputsDir, `${id}.json`), solcVersions: known ? [known] : fallback };
  });
};
var liveImplementations = /* @__PURE__ */ new Map();
var findLiveImplementation = async (hre, proxy, deploymentsNetwork, root) => {
  const slot = await hre.network.provider.request({
    method: "eth_getStorageAt",
    params: [proxy, IMPLEMENTATION_SLOT, "latest"]
  });
  const implementation = `0x${slot.slice(-40)}`.toLowerCase();
  const key = `${deploymentsNetwork}:${implementation}`;
  let live = liveImplementations.get(key);
  if (!live) {
    const deploymentsDir = import_node_path2.default.join(hre.config.paths.root, "deployments", deploymentsNetwork);
    live = resolveSource(hre, implementation, deploymentsDir, root);
    liveImplementations.set(key, live);
  }
  return live;
};
var resolveSource = async (hre, implementation, deploymentsDir, root) => {
  const code = await hre.network.provider.request({
    method: "eth_getCode",
    params: [implementation, "latest"]
  });
  const liveCode = code.slice(2).toLowerCase();
  if (!liveCode.length) throw new Error(`No code at live implementation ${implementation}`);
  const compileErrors = [];
  const saved = candidates(hre, deploymentsDir, implementation);
  for (const pruned of [true, false]) {
    for (const { id, file, solcVersions } of saved) {
      const full = readJson(file);
      const input = pruned ? importClosure(full, root) : full;
      if (!input) continue;
      for (const solcVersion of solcVersions) {
        let compilation;
        try {
          compilation = await compile(hre, input, solcVersion, pruned ? `${id}#${root}` : id);
        } catch (error) {
          if (!pruned) compileErrors.push(`${id} with solc ${solcVersion}: ${error.message}`);
          continue;
        }
        for (const [sourceName, contracts] of Object.entries(compilation.output.contracts)) {
          for (const [contractName, contract] of Object.entries(contracts)) {
            const deployed = contract.evm.deployedBytecode;
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
    `No solc input in ${import_node_path2.default.join(deploymentsDir, "solcInputs")} compiles to the live implementation ${implementation}. Refusing to treat the upgrade as safe without the live source.` + (compileErrors.length ? `
Compiles that failed:
${compileErrors.join("\n")}` : "")
  );
};
var checkUpgradeSafety = async (hre, proxy, contract, { kind = "uups", unsafeAllow, deploymentsNetwork = hre.network.name } = {}) => {
  const opts = (0, import_upgrades_core.withValidationDefaults)(unsafeAllow ? { kind, unsafeAllow } : { kind });
  const { sourceName, contractName } = await hre.artifacts.readArtifact(contract);
  const live = await findLiveImplementation(hre, proxy, deploymentsNetwork, sourceName);
  const newFullyQualifiedName = `${sourceName}:${contractName}`;
  const buildInfo = await hre.artifacts.getBuildInfo(newFullyQualifiedName);
  if (!buildInfo) throw new Error(`No build info for ${newFullyQualifiedName}; compile first`);
  const { input: fullInput, solcVersion, id } = buildInfo;
  const prunedInput = importClosure(fullInput, sourceName);
  const updatedCompilation = await (prunedInput ? compile(hre, prunedInput, solcVersion, `${id}#${sourceName}`).catch(
    () => compile(hre, fullInput, solcVersion, id)
  ) : compile(hre, fullInput, solcVersion, id));
  const updated = await validateCompilation(hre, updatedCompilation);
  const reference = `${live.fullyQualifiedName} @ ${live.solcInputHash}`;
  const problems = [];
  const notes = [];
  const updatedNamespaces = namespacesOf(updatedCompilation.input, updatedCompilation.output, newFullyQualifiedName);
  for (const ns of updatedNamespaces.filter((n) => !isConsistent(n))) {
    problems.push(`Namespace slot mismatch in ${contractName}: ${describeNamespace(ns)}`);
  }
  const renames = [];
  for (const ns of namespacesOf(live.compilation.input, live.compilation.output, live.fullyQualifiedName)) {
    if (isConsistent(ns)) continue;
    const values = ns.constants.map((c) => c.value);
    const match = updatedNamespaces.find(
      (u) => u.contract === ns.contract && u.struct === ns.struct && values.includes(u.annotated)
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
    renames.length ? await compile(
      hre,
      renameAnnotations(compilation.input, renames),
      compilation.solcVersion,
      `${compilation.id}:${renames.map((r) => `${r.from}>${r.to}`).join(",")}`
    ) : compilation
  );
  try {
    (0, import_upgrades_core.assertUpgradeSafe)([updated], (0, import_upgrades_core.getContractVersion)(updated, newFullyQualifiedName), opts);
  } catch (error) {
    problems.push(error.message);
  }
  const originalLayout = (0, import_upgrades_core.getStorageLayout)([original], (0, import_upgrades_core.getContractVersion)(original, live.fullyQualifiedName));
  const updatedLayout = (0, import_upgrades_core.getStorageLayout)([updated], (0, import_upgrades_core.getContractVersion)(updated, newFullyQualifiedName));
  const storageReport = (0, import_upgrades_core.getStorageUpgradeReport)(originalLayout, updatedLayout, opts);
  if (!storageReport.ok) problems.push(storageReport.explain());
  return {
    ok: problems.length === 0,
    liveImplementation: live.implementation,
    reference,
    report: problems.join("\n\n"),
    notes
  };
};
var assertUpgradeSafety = async (hre, proxy, contract, options) => {
  const result = await checkUpgradeSafety(hre, proxy, contract, options);
  if (!result.ok) {
    throw new Error(`Upgrade of ${proxy} from ${result.reference} to ${contract} is unsafe:
${result.report}`);
  }
  return result;
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  IMPLEMENTATION_SLOT,
  assertUpgradeSafety,
  checkUpgradeSafety,
  erc7201
});
//# sourceMappingURL=index.cjs.map