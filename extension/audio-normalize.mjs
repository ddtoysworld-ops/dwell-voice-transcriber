import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output } from 'mediabunny';

export function isAdtsAac(bytes) {
  return bytes instanceof Uint8Array && bytes.length >= 7 && bytes[0] === 0xff &&
    (bytes[1] & 0xf6) === 0xf0 && (bytes[2] & 0x3c) !== 0x3c;
}

export async function normalizeAdtsAudio(bytes, maxBytes = 12 * 1024 * 1024) {
  if (!isAdtsAac(bytes)) return null;
  try {
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BlobSource(new Blob([bytes], { type: 'audio/aac' }))
    });
    const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
    const conversion = await Conversion.init({ input, output });
    if (!conversion.isValid || conversion.discardedTracks.length) throw new Error('Unsupported AAC stream');
    await conversion.execute();
    const buffer = output.target.buffer;
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 12 || buffer.byteLength > maxBytes) {
      throw new Error('Invalid converted audio');
    }
    const header = new Uint8Array(buffer, 4, 4);
    if (String.fromCharCode(...header) !== 'ftyp') throw new Error('Invalid MP4 container');
    return {
      bytes: new Uint8Array(buffer),
      mimeType: 'audio/mp4',
      fileName: 'voice-message.m4a'
    };
  } catch {
    throw Object.assign(new Error('无法转换这段 AAC 语音。'), { code: 'AUDIO_CONVERSION_FAILED' });
  }
}
