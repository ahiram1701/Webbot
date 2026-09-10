// Extrae del bundle ya compilado la funcion que se inyecta en la pagina y la ejecuta aislada,
// igual que hace chrome.scripting.executeScript. Si el bundler hubiera sacado algo fuera de la
// funcion, aqui saltaria un ReferenceError.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../packages/extension/dist/assets", import.meta.url));
const file = readdirSync(dir).find(
  (name) => name.endsWith(".js") && readFileSync(join(dir, name), "utf8").includes("tweetTextarea_0"),
);
if (!file) throw new Error("no se encontro el chunk con el runtime: ejecuta antes 'npm run build'");

const source = readFileSync(join(dir, file), "utf8");
console.log("chunk:", file, `(${(source.length / 1024).toFixed(1)} kB)`);

// La funcion inyectada es la que declara __webbot. Localizamos su inicio y equilibramos llaves.
const marker = source.indexOf("__webbot");
const start = source.lastIndexOf("function ", marker);
if (start < 0) throw new Error("no se localizo el inicio de la funcion");

let depth = 0;
let end = -1;
for (let i = source.indexOf("{", start); i < source.length; i += 1) {
  const char = source[i];
  if (char === "{") depth += 1;
  else if (char === "}") {
    depth -= 1;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }
}
const fnSource = source.slice(start, end);
console.log("funcion extraida:", fnSource.length, "caracteres");
console.log("primeros 90:", fnSource.slice(0, 90).replace(/\n/g, " "));

// Ejecutarla con `new Function` la aisla por completo del resto del bundle.
const scope = {};
const factory = new Function("globalThis", `return (${fnSource})`);
try {
  factory(scope)();
} catch (error) {
  console.error("\nFALLO: la funcion NO es autocontenida ->", error.message);
  process.exit(1);
}

const api = scope.__webbot;
if (!api) {
  console.error("\nFALLO: no instalo __webbot");
  process.exit(1);
}
const metodos = Object.keys(api).sort();
console.log("\nAPI instalada desde el bundle:", metodos.join(", "));
console.log("\nBUNDLE OK: el runtime compilado es autocontenido");
