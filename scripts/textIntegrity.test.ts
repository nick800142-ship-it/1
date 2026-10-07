import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoots = ["src", "api"];
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx"]);

function listSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    return sourceExtensions.has(path.slice(path.lastIndexOf("."))) ? [path] : [];
  });
}

describe("source text integrity", () => {
  it("does not ship replacement characters in user-facing or API text", () => {
    const issues = sourceRoots.flatMap((root) =>
      listSourceFiles(join(process.cwd(), root)).flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .flatMap((line, index) => {
            if (!line.includes("�")) return [];
            if (line.includes('.includes("�")') || line.includes(".includes('�')")) return [];
            return [`${relative(process.cwd(), file)}:${index + 1}`];
          }),
      ),
    );

    expect(issues).toEqual([]);
  });
});
