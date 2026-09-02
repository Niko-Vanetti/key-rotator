import * as os from 'node:os';
import * as path from 'node:path';
import { transcribeAudio } from '../src/chat/audioTranscribe.js';

// Verificación end-to-end del módulo REAL de transcripción (decode ffmpeg +
// Whisper local). Uso: node --import tsx scripts/verify-audio.mts <archivo>
const file = process.argv[2];
if (!file) {
  console.error('Uso: verify-audio.mts <archivo de audio o vídeo>');
  process.exit(1);
}
const modelCacheDir = path.join(os.homedir(), 'Documents', 'KeyRotator Config', 'models');
const t0 = Date.now();
const text = await transcribeAudio(file, { modelCacheDir, onProgress: (m) => console.log('· ' + m) });
console.log(`\n(${((Date.now() - t0) / 1000).toFixed(1)}s)`);
console.log('TEXTO -> ' + JSON.stringify(text));
