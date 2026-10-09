import { describe, expect, it } from "vitest";
import { checkUpgradeSafety, erc7201, type UpgradeSafetyResult } from "../src/index.js";
import { importClosure } from "../src/closure.js";
import { renameAnnotations } from "../src/namespaces.js";
import {
  BOX,
  boxInput,
  DECOY,
  decoyInput,
  deployedCode,
  edit,
  fakeHre,
  IMPLEMENTATION,
  PROXY,
  SOLC_VERSION,
  solcCalls,
  STOPPABLE,
  type SavedInput,
} from "./fixtures.js";

const live = boxInput();
const liveCode = deployedCode(live);

const check = (
  updated = boxInput(),
  {
    saved = [
      { input: decoyInput(), solcVersion: SOLC_VERSION },
      { input: live, solcVersion: SOLC_VERSION },
    ],
    code = liveCode,
  }: {
    saved?: SavedInput[];
    code?: string;
  } = {},
  options: Parameters<typeof checkUpgradeSafety>[3] = {},
): Promise<UpgradeSafetyResult> =>
  checkUpgradeSafety(fakeHre({ liveCode: code, saved, updated }), PROXY, "Box", options);

const STOPPABLE_SLOT = erc7201("test.storage.Stoppable");

describe("erc7201", () => {
  it("matches known slots", () => {
    expect(erc7201("vesper.storage.Shutdownable")).toBe(
      "0x019a888e50c7391e6e8fcd7763e66682aa228549857b7d24cf4bc363dd4e7100",
    );
    expect(erc7201("vault.storage.YieldVault")).toBe(
      "0xea9b954cc57c3e4e2cc61f2841492d7ea35a35ae7a8ac017d9e469b796800500",
    );
  });
});

describe("live source", () => {
  it("is found by bytecode despite filled immutables, past a decoy input", async () => {
    const result = await check();
    expect(result.ok).toBe(true);
    expect(result.liveImplementation).toBe(IMPLEMENTATION);
    expect(result.reference).toMatch(/^Box\.sol:Box @ /);
    expect(result.notes).toEqual([]);
  });

  it("refuses when no saved input compiles to the live code", async () => {
    await expect(check(boxInput(), { saved: [{ input: decoyInput(), solcVersion: SOLC_VERSION }] })).rejects.toThrow(
      /Refusing to treat the upgrade as safe/,
    );
  });

  it("refuses when the only near match differs (a source edit changes the bytecode)", async () => {
    const other = boxInput({
      box: edit(BOX, "return _getBoxStorage()._first;", "return _getBoxStorage()._first + 1;"),
    });
    await expect(check(boxInput(), { saved: [{ input: other, solcVersion: SOLC_VERSION }] })).rejects.toThrow(
      /Refusing/,
    );
  });

  it("falls back to configured versions for an input no artifact records, skipping a failing compiler", async () => {
    const result = await check(boxInput(), { saved: [{ input: live }] });
    expect(result.ok).toBe(true);
  });

  it("refuses when the only matching input can't be compiled", async () => {
    await expect(check(boxInput(), { saved: [{ input: live, solcVersion: "0.8.99" }] })).rejects.toThrow(
      /0\.8\.99 unavailable/,
    );
  });

  it("tries the input of the artifact that records the implementation first", async () => {
    const decoys: SavedInput[] = Array.from({ length: 5 }, (_, i) => ({
      input: {
        ...decoyInput(),
        sources: { [`Decoy${i}.sol`]: { content: `// ${i}\n${decoyInput().sources["Decoy.sol"]?.content ?? ""}` } },
      },
      solcVersion: SOLC_VERSION,
    }));
    // Warm the compile cache for the live input so only decoy compiles are counted
    await check();
    const before = solcCalls.count;
    await check(boxInput(), {
      saved: [...decoys, { input: live, solcVersion: SOLC_VERSION, address: IMPLEMENTATION }],
    });
    // The live input is cached and tried first, so no decoy compiles (the updated input is cached as well)
    expect(solcCalls.count - before).toBe(0);
  });
});

// Fails to compile, so a compile that includes it can't succeed
const BROKEN =
  "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.20;\n\ncontract Broken {\n    uint256 public value\n}\n";

describe("import closure", () => {
  const withSources = (extra: Record<string, string>) => {
    const input = boxInput();
    return {
      ...input,
      sources: {
        ...input.sources,
        ...Object.fromEntries(Object.entries(extra).map(([k, content]) => [k, { content }])),
      },
    };
  };

  it("keeps the root and what it imports, transitively, and nothing else", () => {
    const pruned = importClosure(withSources({ "Unrelated.sol": DECOY, "Broken.sol": BROKEN }), "Box.sol");
    expect(Object.keys(pruned?.sources ?? {}).sort()).toEqual(["Box.sol", "Stoppable.sol"]);
  });

  it("follows relative, multi-line and aliased imports", () => {
    const pruned = importClosure(
      withSources({
        "lib/A.sol": 'import {\n  B\n} from "../lib/sub/B.sol";\nimport * as C from "./C.sol";\ncontract A {}',
        "lib/sub/B.sol": 'import "../D.sol" as D;\ncontract B {}',
        "lib/C.sol": "contract C {}",
        "lib/D.sol": "contract D {}",
        "lib/E.sol": "contract E {}",
      }),
      "lib/A.sol",
    );
    expect(Object.keys(pruned?.sources ?? {}).sort()).toEqual(["lib/A.sol", "lib/C.sol", "lib/D.sol", "lib/sub/B.sol"]);
  });

  it("gives up (full input) when the root is absent, an import does not resolve, or remappings are set", () => {
    expect(importClosure(boxInput(), "Missing.sol")).toBeUndefined();
    expect(
      importClosure(withSources({ "Box.sol": edit(BOX, "./Stoppable.sol", "./Gone.sol") }), "Box.sol"),
    ).toBeUndefined();
    const remapped = boxInput();
    expect(
      importClosure(
        { ...remapped, settings: { ...remapped.settings, remappings: ["a/=b/"] } } as typeof remapped,
        "Box.sol",
      ),
    ).toBeUndefined();
  });

  it("compiles only the closure: an unrelated file that does not compile is ignored, and the bytecode still matches", async () => {
    // The live code comes from the clean input, so a match also shows the pruned compile is byte-identical
    const noisy = withSources({ "Broken.sol": BROKEN });
    const result = await check(noisy, { saved: [{ input: noisy, solcVersion: SOLC_VERSION }] });
    expect(result.report).toBe("");
    expect(result.ok).toBe(true);
    expect(result.reference).toMatch(/^Box\.sol:Box @ /);
  });

  it("falls back to whole inputs for a live contract in a file the new code does not have", async () => {
    const old = { ...boxInput(), sources: { "OldBox.sol": { content: BOX }, "Stoppable.sol": { content: STOPPABLE } } };
    const result = await check(boxInput(), {
      saved: [{ input: old, solcVersion: SOLC_VERSION }],
      code: deployedCode(old, "OldBox.sol"),
    });
    expect(result.report).toBe("");
    expect(result.ok).toBe(true);
    expect(result.reference).toMatch(/^OldBox\.sol:Box @ /);
  });
});

describe("storage layout", () => {
  it("accepts a field appended to a namespace", async () => {
    const result = await check(
      boxInput({ box: edit(BOX, "        address _second;\n", "        address _second;\n        uint256 _third;\n") }),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a field inserted at the start of a namespace", async () => {
    const result = await check(
      boxInput({ box: edit(BOX, "        uint256 _first;\n", "        uint256 _zero;\n        uint256 _first;\n") }),
    );
    expect(result.ok).toBe(false);
    expect(result.report).toMatch(/Inserted `_zero`/);
  });

  it("rejects swapped fields", async () => {
    const swapped = edit(
      BOX,
      "        uint256 _first;\n        address _second;\n",
      "        address _second;\n        uint256 _first;\n",
    );
    const result = await check(boxInput({ box: swapped }));
    expect(result.ok).toBe(false);
  });

  it("rejects a plain state variable inserted before an existing one", async () => {
    const result = await check(
      boxInput({
        box: edit(BOX, "    uint256 public plain;\n", "    uint256 public extra;\n    uint256 public plain;\n"),
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.report).toMatch(/Inserted `extra`/);
  });

  it("rejects a namespace that really moved (annotation and constant both changed)", async () => {
    const moved = edit(
      edit(BOX, "erc7201:test.storage.Box\n", "erc7201:test.storage.BoxV2\n"),
      'keccak256("test.storage.Box")',
      'keccak256("test.storage.BoxV2")',
    );
    const result = await check(boxInput({ box: moved }));
    expect(result.ok).toBe(false);
    expect(result.report).toMatch(/Deleted namespace `erc7201:test.storage.Box`/);
  });
});

describe("slot consistency", () => {
  it("rejects a moved slot constant whose annotation was left unchanged (OZ alone passes this)", async () => {
    const result = await check(
      boxInput({ box: edit(BOX, 'keccak256("test.storage.Box")', 'keccak256("test.storage.Other")') }),
    );
    expect(result.ok).toBe(false);
    expect(result.report).toMatch(
      /Namespace slot mismatch in Box: Box\.BoxStorage: annotated erc7201:test\.storage\.Box/,
    );
  });

  it("hashes the id exactly as written, whitespace included", async () => {
    const result = await check(
      boxInput({ box: edit(BOX, 'keccak256("test.storage.Box")', 'keccak256("test.storage. Box")') }),
    );
    expect(result.ok).toBe(false);
    expect(result.report).toContain(`BOX_STORAGE_LOCATION=${erc7201("test.storage. Box")}`);
  });

  it("reads the annotation OZ reads, not one quoted in prose", async () => {
    const quoted = edit(
      BOX,
      "    /// @custom:storage-location erc7201:test.storage.Box\n",
      "    /// @dev Formerly @custom:storage-location erc7201:test.storage.Moved\n" +
        "    /// @custom:storage-location erc7201:test.storage.Box\n",
    );
    const result = await check(
      boxInput({ box: edit(quoted, 'keccak256("test.storage.Box")', 'keccak256("test.storage.Moved")') }),
    );
    expect(result.ok).toBe(false);
    expect(result.report).toMatch(/Box\.BoxStorage: annotated erc7201:test\.storage\.Box /);
  });

  it("refuses a storage location that is not erc7201", async () => {
    const custom = boxInput({ box: edit(BOX, "erc7201:test.storage.Box\n", "custom:test.storage.Box\n") });
    await expect(check(custom)).rejects.toThrow(/storage location custom:test\.storage\.Box is not erc7201/);
  });

  it("rejects a moved literal constant", async () => {
    const moved = edit(STOPPABLE, STOPPABLE_SLOT, `${STOPPABLE_SLOT.slice(0, -3)}100`);
    const result = await check(boxInput({ stoppable: moved }));
    expect(result.ok).toBe(false);
    expect(result.report).toMatch(/Stoppable\.StoppableStorage: annotated erc7201:test\.storage\.Stoppable/);
  });

  it("rejects a wrong annotation in the new code even when the constant is right", async () => {
    const result = await check(
      boxInput({ stoppable: edit(STOPPABLE, "erc7201:test.storage.Stoppable", "erc7201:test.storage.Old") }),
    );
    expect(result.ok).toBe(false);
    expect(result.report).toMatch(/annotated erc7201:test\.storage\.Old/);
  });

  it("corrects a wrong live annotation from the constant the live code uses", async () => {
    // Like a deployed contract whose annotation was fixed later: the slot never moved
    const misannotated = boxInput({
      stoppable: edit(STOPPABLE, "erc7201:test.storage.Stoppable", "erc7201:test.storage.Old"),
    });
    const result = await check(boxInput(), {
      saved: [{ input: misannotated, solcVersion: SOLC_VERSION }],
      code: deployedCode(misannotated),
    });
    expect(result.report).toBe("");
    expect(result.ok).toBe(true);
    expect(result.notes).toEqual([
      "live Stoppable.StoppableStorage is annotated erc7201:test.storage.Old, but its slot is erc7201:test.storage.Stoppable",
    ]);
  });

  it("refuses to verify a wrong live annotation whose constant the new code does not declare", async () => {
    const otherSlot = erc7201("test.storage.Elsewhere");
    const misannotated = boxInput({ stoppable: edit(STOPPABLE, STOPPABLE_SLOT, otherSlot) });
    const result = await check(boxInput(), {
      saved: [{ input: misannotated, solcVersion: SOLC_VERSION }],
      code: deployedCode(misannotated),
    });
    expect(result.ok).toBe(false);
    expect(result.report).toMatch(/Live implementation cannot be verified: Stoppable\.StoppableStorage/);
  });
});

describe("upgrade safety", () => {
  it("rejects an unsafe construct and accepts it when explicitly allowed", async () => {
    const withConstructor = boxInput({
      box: edit(
        BOX,
        "    uint256 public plain;\n",
        "    uint256 public plain;\n\n    constructor() {\n        plain = 1;\n    }\n",
      ),
    });
    const rejected = await check(withConstructor);
    expect(rejected.ok).toBe(false);
    expect(rejected.report).toMatch(/constructor/i);
    const allowed = await check(withConstructor, undefined, { unsafeAllow: ["constructor"] });
    expect(allowed.ok).toBe(true);
  });
});

describe("renameAnnotations", () => {
  it("renames whole ids only", () => {
    const input = boxInput({
      box: edit(
        BOX,
        "    /// @custom:storage-location erc7201:test.storage.Box\n",
        "    /// @custom:storage-location erc7201:test.storage.Box\n    // erc7201:test.storage.BoxV2\n",
      ),
    });
    const renamed = renameAnnotations(input, [
      { sourceName: "Box.sol", from: "test.storage.Box", to: "test.storage.New" },
    ]);
    const content = renamed.sources["Box.sol"]?.content ?? "";
    expect(content).toContain("erc7201:test.storage.New\n");
    expect(content).toContain("erc7201:test.storage.BoxV2");
  });
});
