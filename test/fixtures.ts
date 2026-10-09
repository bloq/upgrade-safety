import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import solc from "solc";
import {
  TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD,
  TASK_COMPILE_SOLIDITY_RUN_SOLCJS,
} from "hardhat/builtin-tasks/task-names.js";
import type { HardhatRuntimeEnvironment } from "hardhat/types/index.js";
import type { SolcInput, SolcOutput } from "@openzeppelin/upgrades-core";
import { erc7201 } from "../src/index.js";

export const SOLC_VERSION = "0.8.30";
export const IMPLEMENTATION = "0x1111111111111111111111111111111111111111";
export const PROXY = "0x2222222222222222222222222222222222222222";

// Plain storage, a formula-constant namespace (Box), a literal-constant namespace (Stoppable) and a UUPS-style immutable
export const STOPPABLE = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

abstract contract Stoppable {
    /// @custom:storage-location erc7201:test.storage.Stoppable
    struct StoppableStorage {
        bool _stopped;
    }

    bytes32 private constant STOPPABLE_STORAGE_LOCATION = ${erc7201("test.storage.Stoppable")};

    function _getStoppableStorage() private pure returns (StoppableStorage storage $) {
        assembly {
            $.slot := STOPPABLE_STORAGE_LOCATION
        }
    }

    function stopped() public view returns (bool) {
        return _getStoppableStorage()._stopped;
    }
}
`;

export const BOX = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Stoppable} from "./Stoppable.sol";

contract Box is Stoppable {
    /// @custom:storage-location erc7201:test.storage.Box
    struct BoxStorage {
        uint256 _first;
        address _second;
    }

    bytes32 private constant BOX_STORAGE_LOCATION =
        keccak256(abi.encode(uint256(keccak256("test.storage.Box")) - 1)) & ~bytes32(uint256(0xff));

    /// @custom:oz-upgrades-unsafe-allow state-variable-immutable
    address private immutable __self = address(this);

    uint256 public plain;

    function upgradeToAndCall(address, bytes calldata) external payable {
        require(address(this) != __self);
    }

    function _getBoxStorage() private pure returns (BoxStorage storage $) {
        bytes32 _location = BOX_STORAGE_LOCATION;
        assembly {
            $.slot := _location
        }
    }

    function first() external view returns (uint256) {
        return _getBoxStorage()._first;
    }
}
`;

export const DECOY = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Decoy {
    uint256 public value;
}
`;

const settings = { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi"] } } };

// solc needs `language`, which upgrades-core's SolcInput type leaves out
const solcInput = (sources: SolcInput["sources"]): SolcInput =>
  ({ language: "Solidity", sources, settings }) as SolcInput;

export const boxInput = ({ box = BOX, stoppable = STOPPABLE } = {}): SolcInput =>
  solcInput({ "Box.sol": { content: box }, "Stoppable.sol": { content: stoppable } });

export const decoyInput = (): SolcInput => solcInput({ "Decoy.sol": { content: DECOY } });

/** Replaces exactly one occurrence, so a fixture edit can't silently miss. */
export const edit = (source: string, from: string, to: string): string => {
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`expected one occurrence of ${JSON.stringify(from)}, found ${count}`);
  return source.replace(from, to);
};

// Content-derived ids, like hardhat-deploy's solcInputHash: equal inputs share a compile, different ones never collide
export const inputId = (input: SolcInput): string =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 32);

export const solcCalls = { count: 0 };

const solcjs = (input: SolcInput): SolcOutput => {
  solcCalls.count++;
  return JSON.parse(solc.compile(JSON.stringify(input))) as SolcOutput;
};

/** Runtime code of Box compiled from `input`, immutables filled as a real deployment at IMPLEMENTATION would. */
export const deployedCode = (input: SolcInput, sourceName = "Box.sol"): string => {
  const output = solcjs({
    ...input,
    settings: { ...settings, outputSelection: { "*": { "*": ["evm.deployedBytecode"] } } },
  });
  const { object, immutableReferences } = (
    output.contracts[sourceName]?.["Box"]?.evm as unknown as {
      deployedBytecode: { object: string; immutableReferences: Record<string, { start: number; length: number }[]> };
    }
  ).deployedBytecode;
  const refs = Object.values(immutableReferences).flat();
  if (!refs.length) throw new Error("fixture lost its immutable");
  const filled = IMPLEMENTATION.slice(2).padStart(64, "0");
  let code = object;
  for (const { start, length } of refs) {
    code = code.slice(0, start * 2) + filled.slice(-length * 2) + code.slice((start + length) * 2);
  }
  return `0x${code}`;
};

export interface SavedInput {
  input: SolcInput;
  /** Recorded in an artifact's metadata; without it the project's configured versions are tried */
  solcVersion?: string;
  /** Artifact address field, to exercise the ordering hint */
  address?: string;
}

let networks = 0;

/**
 * A fake runtime: a chain where PROXY points at IMPLEMENTATION running `liveCode`, `deployments/<network>` holding
 * `saved`, `updated` as the project's latest compile of Box, and solcjs behind hardhat's solc tasks. Each call gets a
 * fresh network name, so the per-process live-implementation cache never leaks between tests.
 */
export const fakeHre = ({
  liveCode,
  saved,
  updated,
  configuredVersions = [SOLC_VERSION],
}: {
  liveCode: string;
  saved: SavedInput[];
  updated: SolcInput;
  configuredVersions?: string[];
}): HardhatRuntimeEnvironment => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-safety-"));
  const network = `test${++networks}`;
  const deployments = path.join(root, "deployments", network);
  fs.mkdirSync(path.join(deployments, "solcInputs"), { recursive: true });
  saved.forEach(({ input, solcVersion, address }, i) => {
    const id = inputId(input);
    fs.writeFileSync(path.join(deployments, "solcInputs", `${id}.json`), JSON.stringify(input));
    const metadata = solcVersion
      ? JSON.stringify({ compiler: { version: `${solcVersion}+commit.00000000` } })
      : undefined;
    fs.writeFileSync(
      path.join(deployments, `Artifact${i}.json`),
      JSON.stringify({ address: address ?? `0x${String(i + 3).repeat(40)}`, solcInputHash: id, metadata }),
    );
  });

  const run = (task: string, args: { solcVersion?: string; input?: SolcInput }) => {
    if (task === TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD) {
      // Only one compiler exists in tests; any other version fails like a pragma or download failure would
      if (args.solcVersion !== SOLC_VERSION)
        return Promise.reject(new Error(`solc ${String(args.solcVersion)} unavailable`));
      return Promise.resolve({ isSolcJs: true, compilerPath: "solcjs" });
    }
    if (task === TASK_COMPILE_SOLIDITY_RUN_SOLCJS && args.input) return Promise.resolve(solcjs(args.input));
    return Promise.reject(new Error(`unexpected task ${task}`));
  };

  const provider = {
    request: ({ method, params = [] }: { method: string; params?: unknown[] }) => {
      const [address] = params;
      if (method === "eth_getStorageAt" && address === PROXY) {
        return Promise.resolve(`0x${IMPLEMENTATION.slice(2).padStart(64, "0")}`);
      }
      if (method === "eth_getCode" && address === IMPLEMENTATION) return Promise.resolve(liveCode);
      return Promise.reject(new Error(`unexpected ${method} ${String(address)}`));
    },
  };

  return {
    network: { name: network, provider },
    config: {
      paths: { root },
      solidity: { compilers: configuredVersions.map(version => ({ version })), overrides: {} },
    },
    run,
    artifacts: {
      readArtifact: () => Promise.resolve({ sourceName: "Box.sol", contractName: "Box" }),
      getBuildInfo: () => Promise.resolve({ id: inputId(updated), input: updated, solcVersion: SOLC_VERSION }),
    },
  } as unknown as HardhatRuntimeEnvironment;
};
