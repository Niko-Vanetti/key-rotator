import * as fs from 'node:fs';
import * as path from 'node:path';

// transformers.js hace `import sharp from 'sharp'` de forma estática, pero solo
// lo usa para PROCESAR IMÁGENES — algo que la transcripción de audio nunca hace
// (el código real es `else if (sharp) {…}`). sharp pesa 50 MB de binarios
// nativos, así que antes de empaquetar lo reemplazamos por un stub que exporta
// null: el import resuelve y la rama de imágenes queda inerte. `npm install`
// restaura el sharp real (inofensivo); este script se re-aplica al empaquetar.
const dir = path.resolve('node_modules/sharp');
fs.mkdirSync(dir, { recursive: true });
// Debe ser TRUTHY: transformers hace `else if (sharp)` al cargar el módulo y
// lanza si es falsy. Como función pasa la comprobación; solo fallaría si de
// verdad se procesara una imagen (algo que el audio nunca hace).
fs.writeFileSync(
  path.join(dir, 'index.js'),
  "module.exports = function sharp(){ throw new Error('sharp no incluido en esta build (solo audio/texto)'); };\n"
);
fs.writeFileSync(
  path.join(dir, 'package.json'),
  // versión dentro del rango ^0.32.0 que pide transformers (si no, vsce/npm ls falla)
  JSON.stringify({ name: 'sharp', version: '0.32.6', main: 'index.js' }, null, 2) + '\n'
);
// borramos lo que el sharp real dejara alrededor para no colar sus 50 MB
for (const junk of ['build', 'vendor', 'src', 'install', 'lib']) {
  fs.rmSync(path.join(dir, junk), { recursive: true, force: true });
}
console.log('sharp → stub (null) aplicado en', dir);
