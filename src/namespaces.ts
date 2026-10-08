import type { SolcInput, SolcOutput } from "@openzeppelin/upgrades-core";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

// OZ derives each namespace's slot from its `@custom:storage-location erc7201:<id>` annotation and never reads the slot
// the code actually uses. These helpers tie the two together, so a wrong annotation can't hide a moved slot.

// Line-anchored like OZ, so a tag quoted mid-line in prose is not the one read
const ANNOTATION = /^\s*@custom:storage-location\s+(\S+)/m;
const FORMULA = /^keccak256\(abi\.encode\(uint256\(keccak256\("([^"\\]+)"\)\)-1\)\)&~bytes32\(uint256\(0xff\)\)$/;
// Whitespace outside string literals, so the id inside them is hashed exactly as written
const SPACING = /("(?:[^"\\]|\\.)*")|\s+/g;
const WORD = /^0x[0-9a-fA-F]{64}$/;

const toWord = (value: bigint): string => `0x${value.toString(16).padStart(64, "0")}`;

/** The ERC-7201 slot of namespace `id`: keccak256(abi.encode(uint256(keccak256(id)) - 1)) & ~bytes32(uint256(0xff)) */
export const erc7201 = (id: string): string => {
  const inner = BigInt(`0x${bytesToHex(keccak_256(utf8ToBytes(id)))}`) - 1n;
  const outer = BigInt(`0x${bytesToHex(keccak_256(hexToBytes(toWord(inner).slice(2))))}`) & ~0xffn;
  return toWord(outer);
};

// The few solc AST fields read here
interface AstNode {
  id: number;
  nodeType: string;
  name?: string;
  src: string;
  nodes?: AstNode[];
  constant?: boolean;
  value?: AstNode & { kind?: string; value?: string };
  typeDescriptions?: { typeString?: string };
  documentation?: { text?: string };
  linearizedBaseContracts?: number[];
}

export interface Namespace {
  contract: string;
  struct: string;
  id: string;
  sourceName: string;
  /** Slot the annotation implies */
  annotated: string;
  /** bytes32 constants visible in the contract (its own and file-level) whose value could be evaluated */
  constants: { name: string; value: string }[];
}

/** A constant's value: a 32-byte hex literal, or the standard ERC-7201 formula over a string literal. */
const evaluate = (node: AstNode["value"], source: Buffer): string | undefined => {
  if (!node) return undefined;
  if (node.nodeType === "Literal" && node.kind === "number" && node.value && WORD.test(node.value)) {
    return node.value.toLowerCase();
  }
  const [start = 0, length = 0] = node.src.split(":").map(Number);
  const text = source
    .subarray(start, start + length)
    .toString("utf8")
    .replace(SPACING, (_, literal?: string) => literal ?? "");
  const id = FORMULA.exec(text)?.[1];
  return id === undefined ? undefined : erc7201(id);
};

const bytes32Constants = (nodes: AstNode[], source: Buffer): Namespace["constants"] =>
  nodes.flatMap(n => {
    if (n.nodeType !== "VariableDeclaration" || !n.constant || n.typeDescriptions?.typeString !== "bytes32") return [];
    const value = evaluate(n.value, source);
    return value === undefined ? [] : [{ name: n.name ?? "", value }];
  });

/** Every ERC-7201 namespace declared by `fullyQualifiedName` or the contracts it inherits from. */
export const namespacesOf = (input: SolcInput, output: SolcOutput, fullyQualifiedName: string): Namespace[] => {
  const contracts = new Map<number, { node: AstNode; sourceName: string }>();
  for (const [sourceName, { ast }] of Object.entries(output.sources)) {
    for (const node of (ast as AstNode).nodes ?? []) {
      if (node.nodeType === "ContractDefinition") contracts.set(node.id, { node, sourceName });
    }
  }
  const separator = fullyQualifiedName.lastIndexOf(":");
  const targetSource = fullyQualifiedName.slice(0, separator);
  const targetName = fullyQualifiedName.slice(separator + 1);
  const target = [...contracts.values()].find(c => c.sourceName === targetSource && c.node.name === targetName);
  if (!target) throw new Error(`${fullyQualifiedName} not found in the compilation`);

  const namespaces: Namespace[] = [];
  for (const id of target.node.linearizedBaseContracts ?? []) {
    const contract = contracts.get(id);
    if (!contract) continue;
    const { node, sourceName } = contract;
    const content = input.sources[sourceName]?.content;
    if (content === undefined) throw new Error(`No source content for ${sourceName}`);
    const source = Buffer.from(content, "utf8");
    const fileNodes = (output.sources[sourceName]?.ast as AstNode | undefined)?.nodes ?? [];
    const constants = [...bytes32Constants(node.nodes ?? [], source), ...bytes32Constants(fileNodes, source)];
    for (const struct of (node.nodes ?? []).filter(n => n.nodeType === "StructDefinition")) {
      const location = ANNOTATION.exec(struct.documentation?.text ?? "")?.[1];
      if (location === undefined) continue;
      if (!location.startsWith("erc7201:")) {
        throw new Error(
          `${node.name ?? ""}.${struct.name ?? ""}: storage location ${location} is not erc7201, so its slot can't be checked`,
        );
      }
      const annotation = location.slice("erc7201:".length);
      namespaces.push({
        contract: node.name ?? "",
        struct: struct.name ?? "",
        id: annotation,
        sourceName,
        annotated: erc7201(annotation),
        constants,
      });
    }
  }
  return namespaces;
};

export const isConsistent = (ns: Namespace): boolean => ns.constants.some(c => c.value === ns.annotated);

export const describeNamespace = (ns: Namespace): string =>
  `${ns.contract}.${ns.struct}: annotated erc7201:${ns.id} (slot ${ns.annotated}) but its bytes32 constants are ` +
  (ns.constants.length ? ns.constants.map(c => `${c.name}=${c.value}`).join(", ") : "none that could be evaluated");

export interface AnnotationRename {
  sourceName: string;
  from: string;
  to: string;
}

/** Rewrites `erc7201:<from>` annotations to `<to>` in the given sources of `input`. Comments only, so code is unchanged. */
export const renameAnnotations = (input: SolcInput, renames: readonly AnnotationRename[]): SolcInput => {
  const sources = { ...input.sources };
  for (const { sourceName, from, to } of renames) {
    const source = sources[sourceName];
    if (source?.content === undefined) throw new Error(`No source content for ${sourceName}`);
    // Whole ids only: renaming `a.B` must not touch `a.BV2`
    const pattern = new RegExp(`erc7201:${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=\\s|$)`, "g");
    sources[sourceName] = { ...source, content: source.content.replace(pattern, `erc7201:${to}`) };
  }
  return { ...input, sources };
};
