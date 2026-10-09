import path from "node:path";
import type { SolcInput } from "@openzeppelin/upgrades-core";

// `import "x";`, `import "x" as y;`, `import * as y from "x";`, `import {a, b} from "x";` (may span lines)
const IMPORT = /^\s*import\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gm;

/**
 * `input` reduced to `root` and the files it imports, transitively, in the input's own order. A contract's bytecode,
 * metadata hash included, normally depends only on these files, so compiling them alone gives the same bytecode as the
 * full input at a fraction of the cost: hardhat-deploy saves the whole project in every input. Undefined for `root`
 * absent, remappings, or an import that doesn't resolve to a source in the input. The scan is textual, so an import it
 * misses surfaces as a compile error; callers then compile the full input, which also covers any bytecode difference.
 */
export const importClosure = (input: SolcInput, root: string): SolcInput | undefined => {
  const remappings = (input.settings as { remappings?: unknown[] } | undefined)?.remappings;
  if (remappings?.length || !input.sources[root]) return undefined;

  const closure = new Set<string>();
  const pending = [root];
  for (let sourceName = pending.pop(); sourceName !== undefined; sourceName = pending.pop()) {
    if (closure.has(sourceName)) continue;
    const content = input.sources[sourceName]?.content;
    if (content === undefined) return undefined;
    closure.add(sourceName);
    for (const [, imported = ""] of content.matchAll(IMPORT)) {
      const resolved = imported.startsWith(".")
        ? path.posix.normalize(path.posix.join(path.posix.dirname(sourceName), imported))
        : imported;
      if (!input.sources[resolved]) return undefined;
      pending.push(resolved);
    }
  }
  const sources = Object.fromEntries(Object.entries(input.sources).filter(([s]) => closure.has(s)));
  return { ...input, sources };
};
