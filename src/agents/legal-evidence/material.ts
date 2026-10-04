import fs from "node:fs";
import path from "node:path";
import { checkedDirectory, readCheckedFile } from "./files.js";
import { bytesHash, evidenceHash } from "./hash.js";
import { assertEvidenceSchema } from "./schema.js";
export type MaterialInventory = { version: 1; files: Array<{ path: string; sha256: string }> };
/** Measurement roots contain the exact shipped material, excluding the approval envelope itself. */
export function measureMaterialInventory(
  root: string,
  inventory: MaterialInventory,
): MaterialInventory {
  checkedDirectory(root);
  if (
    !inventory ||
    Object.keys(inventory).toSorted().join(",") !== "files,version" ||
    inventory.version !== 1 ||
    !Array.isArray(inventory.files) ||
    !inventory.files.length ||
    inventory.files.length > 20_000
  ) {
    throw new Error("evidence-inventory-invalid");
  }
  let prior = "";
  for (const file of inventory.files) {
    if (
      Object.keys(file).toSorted().join(",") !== "path,sha256" ||
      typeof file.path !== "string" ||
      file.path <= prior ||
      !/^[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)*$/.test(file.path) ||
      file.path.split("/").some((p) => p === "." || p === "..")
    ) {
      throw new Error("evidence-inventory-path");
    }
    assertEvidenceSchema("Hash", file.sha256);
    prior = file.path;
  }
  const actual: string[] = [];
  function walk(directory: string, relative: string, depth: number): void {
    if (depth > 32) {
      throw new Error("evidence-inventory-depth");
    }
    checkedDirectory(directory);
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name),
        rel = relative ? relative + "/" + name : name,
        stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        throw new Error("evidence-inventory-link");
      }
      if (stat.isDirectory()) {
        walk(file, rel, depth + 1);
      } else if (stat.isFile() && stat.nlink === 1) {
        actual.push(rel);
      } else {
        throw new Error("evidence-inventory-file");
      }
      if (actual.length > 20_000) {
        throw new Error("evidence-inventory-limit");
      }
    }
  }
  walk(root, "", 0);
  actual.sort();
  if (evidenceHash(actual) !== evidenceHash(inventory.files.map((f) => f.path))) {
    throw new Error("evidence-inventory-missing-or-unexpected");
  }
  for (const file of inventory.files) {
    if (
      bytesHash(readCheckedFile(path.join(root, ...file.path.split("/")), 32_000_000)) !==
      file.sha256
    ) {
      throw new Error("evidence-inventory-drift");
    }
  }
  return structuredClone(inventory);
}
export function materialInventoryHash(
  inventory: MaterialInventory,
  domain: { engineRevision: string } | { package: "@mariozechner/pi-ai"; packageVersion: "0.57.1" },
): string {
  return evidenceHash({ version: 1, ...domain, files: inventory.files });
}
