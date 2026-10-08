import { HardhatRuntimeEnvironment } from 'hardhat/types/index.js';
import { ValidationOptions } from '@openzeppelin/upgrades-core';

/** The ERC-7201 slot of namespace `id`: keccak256(abi.encode(uint256(keccak256(id)) - 1)) & ~bytes32(uint256(0xff)) */
declare const erc7201: (id: string) => string;

/** ERC-1967 implementation slot, see `ERC1967Utils.sol` */
declare const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
interface UpgradeSafetyOptions {
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
interface UpgradeSafetyResult {
    ok: boolean;
    liveImplementation: string;
    /** Fully qualified name of the live implementation's source, e.g. `src/Gateway.sol:Gateway @ <solcInputHash>` */
    reference: string;
    /** Why the upgrade is unsafe; empty when `ok` */
    report: string;
    /** Corrections applied to the live source's annotations, each justified by the slot constant it actually uses */
    notes: string[];
}
/**
 * Compares the implementation currently behind `proxy` with `contract` from this project's latest compile, using the
 * same checks as OZ's `validateUpgrade`: the new implementation must be upgrade safe, and its storage layout
 * (including ERC-7201 namespaces) must be compatible with the live one. OZ takes each namespace's slot from its
 * annotation, so this also checks every annotation against the slot constant the code actually uses.
 */
declare const checkUpgradeSafety: (hre: HardhatRuntimeEnvironment, proxy: string, contract: string, { kind, unsafeAllow, deploymentsNetwork }?: UpgradeSafetyOptions) => Promise<UpgradeSafetyResult>;
/** `checkUpgradeSafety`, throwing with the report when the upgrade is unsafe. */
declare const assertUpgradeSafety: (hre: HardhatRuntimeEnvironment, proxy: string, contract: string, options?: UpgradeSafetyOptions) => Promise<UpgradeSafetyResult>;

export { IMPLEMENTATION_SLOT, type UpgradeSafetyOptions, type UpgradeSafetyResult, assertUpgradeSafety, checkUpgradeSafety, erc7201 };
