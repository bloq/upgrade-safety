# @bloq/upgrade-safety

Checks a proxy upgrade against the storage layout that is **actually live**, for Hardhat 2 + hardhat-deploy projects.

## Why

OpenZeppelin's `upgrades.validateUpgrade(oldFactory, newFactory)` needs the old implementation's source in the current
build. Built from a deployment artifact, it fails with `contract not found` for any implementation compiled before the
current build, and even when it runs it checks the artifact, which can drift from what the proxy runs.
`forceImport(proxy, currentFactory)` records the layout of whatever factory you pass, so the next check compares the
current code with itself and cannot fail.

This package compares against the source that compiles to the live bytecode, and closes a gap in OpenZeppelin's
ERC-7201 handling (see [Slot consistency](#slot-consistency)).

## How it works

1. Read the live implementation from the proxy's ERC-1967 slot.
2. Recompile each input hardhat-deploy saved in `deployments/<network>/solcInputs`, with the solc version its artifacts
   record (or the project's configured versions), and keep the contract whose deployed bytecode equals the live code,
   immutables masked. Inputs of artifacts that record the live address are tried first; the bytecode match alone
   decides. If no input matches, the check throws rather than passes.
3. Compare the new implementation with it using OpenZeppelin's checks: upgrade safety (`assertUpgradeSafe`) and the
   storage upgrade report, including ERC-7201 namespaces.

### Slot consistency

OpenZeppelin takes each namespace's slot from its `@custom:storage-location erc7201:<id>` annotation and never reads the
slot the code uses. So a slot constant moved under an unchanged annotation passes, and a live contract whose annotation
was wrong (while its constant was right) fails even though nothing moved.

Every annotation in the inheritance chain is therefore checked against the contract's `bytes32` constants, evaluated
from a hex literal or the standard formula `keccak256(abi.encode(uint256(keccak256("<id>")) - 1)) &
~bytes32(uint256(0xff))`:

- a mismatch in the **new** code is unsafe;
- a mismatch in the **live** code is corrected from its constant, the slot actually in use, but only to the id the new
  code declares for the same struct, and reported in `notes`. Anything else is unsafe.

A slot constant written any other way (a different expression, or one from another file or library) cannot be
evaluated, so its namespace is reported unsafe rather than assumed consistent.

### Limits

- A namespace passes when any of its contract's evaluable constants equals its annotated slot. Which constant its
  getter actually loads is not traced, so a getter moved to a new slot while the old constant stays behind goes
  unnoticed. Review slot changes in the diff.
- Only `erc7201:` storage locations are supported; any other formula makes the check throw.
- With `bytecodeHash: "none"` (no metadata hash), two contracts with identical bytecode can't be told apart, so the live
  source could resolve to the wrong one.
- The live match is cached per implementation address for the life of the process. If different code lands at the same
  address (a reset or `hardhat_setCode` in a test), use a new process.

## Install

Not on npm: install a release tag from git. Each tag carries the built `dist`, so nothing is built on install.

```json
"@bloq/upgrade-safety": "github:bloq/upgrade-safety#v0.1.0"
```

Needs Node 22+, and as peers `hardhat` 2.26+ and `@openzeppelin/upgrades-core` 1.44.2+.

## Usage

Run `compile` first: the new implementation comes from the project's latest build info.

```ts
import { assertUpgradeSafety, checkUpgradeSafety } from "@bloq/upgrade-safety";

// In a deploy helper, before deploying a new implementation or queuing an upgrade: throws with the report if unsafe
const { reference, notes } = await assertUpgradeSafety(hre, proxy.address, "StakeDao");

// Or inspect the result, e.g. in a task that checks many proxies
const result = await checkUpgradeSafety(hre, vaultAddress, "WhitelistedYieldVault", {
  kind: "uups",
  unsafeAllow: ["missing-initializer"],
  deploymentsNetwork: "ethereum",
});
if (!result.ok) console.log(result.report);
```

### Options

| Option               | Default            | Meaning                                                                                        |
| -------------------- | ------------------ | ---------------------------------------------------------------------------------------------- |
| `kind`               | `"uups"`           | Proxy kind for OpenZeppelin's checks: `"uups"` or `"transparent"` (not beacon proxies)         |
| `unsafeAllow`        | none               | OpenZeppelin checks to waive for the new implementation. Never affects the storage check       |
| `deploymentsNetwork` | `hre.network.name` | Whose `deployments/<network>/solcInputs` hold the live source, e.g. on a fork run as `hardhat` |

### Result

| Field                | Meaning                                                               |
| -------------------- | --------------------------------------------------------------------- |
| `ok`                 | The upgrade is safe                                                   |
| `liveImplementation` | Implementation address read from the proxy                            |
| `reference`          | Live source that matched, `<sourceName>:<contract> @ <solcInputHash>` |
| `report`             | Why it is unsafe; empty when `ok`                                     |
| `notes`              | Live annotations corrected from their slot constants, one line each   |

`checkUpgradeSafety` throws when the live source cannot be found (no saved input compiles to the live code) or the new
contract has no build info. `assertUpgradeSafety` also throws when the upgrade is unsafe.

Compiles are cached per process, so a run over many proxies on one implementation compiles it once. A miss still costs
a full compile per saved input, which is slow on large viaIR projects.

## Development

```sh
pnpm install
pnpm test        # unit tests: solcjs behind a fake hre, no RPC
pnpm lint && pnpm typecheck && pnpm build
pnpm release     # tags a release commit carrying dist; pushing the tag is left to you
```
