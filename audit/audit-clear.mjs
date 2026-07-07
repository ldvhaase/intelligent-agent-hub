// Windows-safe replacement for `rm -rf .audit` (this repo is developed on
// Windows, so the shell-specific script from the spec is swapped per its
// own carve-out).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const auditDir = path.resolve(__dirname, "..", ".audit");

fs.rmSync(auditDir, { recursive: true, force: true });
console.log(`cleared ${auditDir}`);
