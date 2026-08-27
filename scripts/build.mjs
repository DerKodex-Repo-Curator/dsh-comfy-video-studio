import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const source = await readFile(join(root, "src", "client.template.js"), "utf8");
const css = await readFile(join(root, "src", "studio.css"), "utf8");
const host = await readFile(join(root, "src", "index.js"), "utf8");
const workflowPresets = await readFile(join(root, "src", "workflow-presets.js"), "utf8");

const clientBody = source.replace("__STUDIO_CSS__", JSON.stringify(css));
if (clientBody === source || /__[A-Z0-9_]+__/.test(clientBody)) {
  throw new Error("client bundle contains an unresolved build placeholder");
}

const clientBundle = `window.__ModuleLoader__.load({\n  id: ${JSON.stringify(pkg.name)},\n  factory: (require) => {\n    const module = { exports: {} };\n    const exports = module.exports;\n${clientBody.split("\n").map((line) => `    ${line}`).join("\n")}\n    exports.apply = apply;\n    exports.inject = inject;\n    return module.exports;\n  }\n});\n`;

await mkdir(join(root, "lib"), { recursive: true });
await writeFile(join(root, "lib", "client.js"), clientBundle);
await writeFile(join(root, "lib", "index.js"), host);
await writeFile(join(root, "lib", "workflow-presets.js"), workflowPresets);
console.log(`built ${pkg.name}: host ${Buffer.byteLength(host)} bytes, client ${Buffer.byteLength(clientBundle)} bytes`);
