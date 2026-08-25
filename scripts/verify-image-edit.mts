/**
 * Verifica el ciclo COMPLETO de imágenes contra la API real de NVIDIA Build:
 *   1) genera una imagen base,
 *   2) la edita (subida de asset + example_id + cabecera de referencia).
 *
 * Uso:  node --import tsx scripts/verify-image-edit.mts <nvapi-key> [modelo-edit]
 *
 * No reutilices una key que hayas pegado en un chat: genera una nueva en
 * build.nvidia.com para esta prueba y bórrala después si quieres.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { runImage } from '../src/agent/imageRunner.js';

const [apiKey, editModel = 'black-forest-labs/flux.1-kontext-dev'] = process.argv.slice(2);
if (!apiKey) {
  console.error('Uso: node --import tsx scripts/verify-image-edit.mts <nvapi-key> [modelo-edit]');
  process.exit(1);
}
const outDir = path.join(os.tmpdir(), 'kr-image-verify');
const log = (s: string) => console.log(s);

log('1) Generando imagen base con flux.1-dev…');
const gen = await runImage({
  apiKey,
  model: 'black-forest-labs/flux.1-dev',
  prompt: 'a simple red cube on a white background, product photo',
  outDir,
  onStatus: (s) => log('   ' + s),
});
if (!gen.ok || !gen.file) {
  console.error(`   ❌ falló la generación: ${gen.detail}`);
  console.error('   (los modelos de imagen de la capa gratuita devuelven 500 a menudo; reintenta)');
  process.exit(1);
}
log(`   ✅ base generada: ${gen.file}`);

log(`2) Editando esa imagen con ${editModel}…`);
const edit = await runImage({
  apiKey,
  model: editModel,
  prompt: 'change the cube color to blue',
  inputFile: gen.file,
  outDir,
  onStatus: (s) => log('   ' + s),
});
if (!edit.ok || !edit.file) {
  console.error(`   ❌ falló la edición: ${edit.detail}`);
  process.exit(1);
}
log(`   ✅ EDICIÓN OK: ${edit.file}`);
log('\nTodo el ciclo generar→editar funciona contra la API real.');
