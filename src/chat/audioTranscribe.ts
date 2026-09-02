import { spawn } from 'node:child_process';

// Transcripción de voz 100% local con Whisper (transformers.js + onnxruntime).
// Decodifica cualquier formato con ffmpeg del sistema y transcribe en CPU con
// whisper-tiny cuantizado — pensado para correr en máquinas modestas. El modelo
// se descarga una sola vez a la carpeta caché y queda para siempre.

// import() real que esbuild NO debe convertir a require (el paquete es ESM).
const dynImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;

let pipelinePromise: Promise<any> | null = null;
let ffmpegBin: string | null = null;

export interface TranscribeDeps {
  modelCacheDir: string;
  /** ruta a ffmpeg; por defecto usa 'ffmpeg' del PATH */
  ffmpegPath?: string;
  onProgress?: (msg: string) => void;
}

function resolveFfmpeg(dep?: string): string {
  if (dep) return dep;
  if (ffmpegBin) return ffmpegBin;
  // ffmpeg-static es opcional: si está instalado lo usamos, si no, el del PATH.
  try {
    const p = require('ffmpeg-static') as string | null;
    ffmpegBin = p || 'ffmpeg';
  } catch {
    ffmpegBin = 'ffmpeg';
  }
  return ffmpegBin;
}

/** Decodifica un archivo de audio/vídeo a PCM mono 16 kHz Float32 vía ffmpeg. */
export function decodeToPcm(file: string, ffmpeg: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'];
    const proc = spawn(ffmpeg, args);
    const chunks: Buffer[] = [];
    let err = '';
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d: Buffer) => (err += d.toString()));
    proc.on('error', (e) => {
      reject(
        (e as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error('No encontré ffmpeg. Instálalo (https://ffmpeg.org) para transcribir audio y vídeo.')
          : e
      );
    });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `ffmpeg terminó con código ${code}`));
      const buf = Buffer.concat(chunks);
      if (buf.length < 4) return reject(new Error('El archivo no contenía audio.'));
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)));
    });
  });
}

async function getPipeline(deps: TranscribeDeps): Promise<any> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const tf = await dynImport('@xenova/transformers');
      tf.env.allowLocalModels = false;
      tf.env.cacheDir = deps.modelCacheDir; // el modelo persiste aquí
      deps.onProgress?.('Cargando el modelo de voz (la primera vez se descarga, ~40 MB)…');
      return tf.pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny');
    })();
  }
  return pipelinePromise;
}

/** Transcribe un archivo de audio o vídeo a texto. Devuelve null si sale vacío. */
export async function transcribeAudio(file: string, deps: TranscribeDeps): Promise<string | null> {
  const ffmpeg = resolveFfmpeg(deps.ffmpegPath);
  const samples = await decodeToPcm(file, ffmpeg);
  if (samples.length < 1600) return null; // < 0,1 s: nada que transcribir
  const transcriber = await getPipeline(deps);
  deps.onProgress?.('Transcribiendo…');
  const res = await transcriber(samples, {
    task: 'transcribe',
    chunk_length_s: 30, // trocea audios largos
    stride_length_s: 5,
    return_timestamps: false,
  });
  const text = (typeof res?.text === 'string' ? res.text : '').trim();
  return text.length ? text : null;
}
