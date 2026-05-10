function readString(buffer, start, length) {
  return buffer.toString('ascii', start, start + length);
}

function parseWavBuffer(buffer, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
    throw new Error('Invalid WAV buffer.');
  }

  if (readString(buffer, 0, 4) !== 'RIFF' || readString(buffer, 8, 4) !== 'WAVE') {
    throw new Error('Unsupported WAV container.');
  }

  let offset = 12;
  let format = null;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = readString(buffer, offset, 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;

    if (chunkDataOffset + chunkSize > buffer.length) {
      throw new Error('Corrupt WAV chunk size.');
    }

    if (chunkId === 'fmt ') {
      if (chunkSize < 16) {
        throw new Error('Unsupported WAV fmt chunk.');
      }

      format = {
        audioFormat: buffer.readUInt16LE(chunkDataOffset),
        numChannels: buffer.readUInt16LE(chunkDataOffset + 2),
        sampleRate: buffer.readUInt32LE(chunkDataOffset + 4),
        byteRate: buffer.readUInt32LE(chunkDataOffset + 8),
        blockAlign: buffer.readUInt16LE(chunkDataOffset + 12),
        bitsPerSample: buffer.readUInt16LE(chunkDataOffset + 14),
      };
    } else if (chunkId === 'data') {
      dataOffset = chunkDataOffset;
      dataSize = chunkSize;
    }

    offset = chunkDataOffset + chunkSize + (chunkSize % 2);
  }

  if (!format || dataOffset < 0) {
    throw new Error('WAV buffer is missing required fmt or data chunks.');
  }

  if (format.audioFormat !== 1 && options.allowNonPcm !== true) {
    throw new Error('Only PCM WAV audio is supported for stitching.');
  }

  const data = buffer.slice(dataOffset, dataOffset + dataSize);
  return {
    ...format,
    data,
  };
}

function writeWavBuffer({ sampleRate, bitsPerSample, numChannels, data }) {
  const pcmData = Buffer.isBuffer(data) ? data : Buffer.from(data || '');
  const header = Buffer.alloc(44);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcmData.length, 40);

  return Buffer.concat([header, pcmData]);
}

function wavFormatsMatch(left = {}, right = {}) {
  return Number(left?.audioFormat || 0) === Number(right?.audioFormat || 0)
    && Number(left?.numChannels || 0) === Number(right?.numChannels || 0)
    && Number(left?.sampleRate || 0) === Number(right?.sampleRate || 0)
    && Number(left?.bitsPerSample || 0) === Number(right?.bitsPerSample || 0);
}

function readInt16Sample(data, frameIndex, channelIndex, channelCount) {
  const offset = ((frameIndex * channelCount) + channelIndex) * 2;
  return data.readInt16LE(offset);
}

function clampInt16(value) {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

function readSampleAsInt16(format, frameIndex, channelIndex) {
  const offset = ((frameIndex * format.numChannels) + channelIndex) * (format.bitsPerSample / 8);

  if (format.audioFormat === 1) {
    if (format.bitsPerSample === 16) {
      return format.data.readInt16LE(offset);
    }
    if (format.bitsPerSample === 8) {
      return clampInt16((format.data.readUInt8(offset) - 128) * 256);
    }
    if (format.bitsPerSample === 24) {
      return clampInt16(format.data.readIntLE(offset, 3) / 256);
    }
    if (format.bitsPerSample === 32) {
      return clampInt16(format.data.readInt32LE(offset) / 65536);
    }
  }

  if (format.audioFormat === 3) {
    const floatValue = format.bitsPerSample === 32
      ? format.data.readFloatLE(offset)
      : format.data.readDoubleLE(offset);
    return clampInt16(Math.max(-1, Math.min(1, floatValue)) * 32767);
  }

  throw new Error('Unsupported WAV sample format for PCM conversion.');
}

function resolveInt16SampleForChannel(data, frameIndex, sourceChannels, targetChannels, targetChannelIndex) {
  if (sourceChannels === targetChannels) {
    return readInt16Sample(data, frameIndex, targetChannelIndex, sourceChannels);
  }

  if (sourceChannels === 1 && targetChannels === 2) {
    return readInt16Sample(data, frameIndex, 0, sourceChannels);
  }

  if (sourceChannels === 2 && targetChannels === 1) {
    const left = readInt16Sample(data, frameIndex, 0, sourceChannels);
    const right = readInt16Sample(data, frameIndex, 1, sourceChannels);
    return Math.round((left + right) / 2);
  }

  throw new Error('Only mono and stereo PCM WAV normalization is supported.');
}

function resolveInt16SampleForChannelFromFormat(format, frameIndex, targetChannels, targetChannelIndex) {
  if (format.numChannels === targetChannels) {
    return readSampleAsInt16(format, frameIndex, targetChannelIndex);
  }

  if (format.numChannels === 1 && targetChannels === 2) {
    return readSampleAsInt16(format, frameIndex, 0);
  }

  if (format.numChannels === 2 && targetChannels === 1) {
    const left = readSampleAsInt16(format, frameIndex, 0);
    const right = readSampleAsInt16(format, frameIndex, 1);
    return Math.round((left + right) / 2);
  }

  throw new Error('Only mono and stereo WAV normalization is supported.');
}

function normalizeWavBufferFormat(buffer, targetFormat = {}) {
  const source = parseWavBuffer(buffer, { allowNonPcm: true });
  const target = {
    audioFormat: 1,
    sampleRate: Number(targetFormat?.sampleRate || source.sampleRate || 0),
    bitsPerSample: Number(targetFormat?.bitsPerSample || 16),
    numChannels: Number(targetFormat?.numChannels || source.numChannels || 0),
  };

  if (wavFormatsMatch(source, target)) {
    return buffer;
  }

  if (![1, 3].includes(source.audioFormat) || target.audioFormat !== 1) {
    throw new Error('Only PCM or IEEE float WAV normalization is supported.');
  }

  if (!([8, 16, 24, 32].includes(source.bitsPerSample) || (source.audioFormat === 3 && source.bitsPerSample === 64))
    || target.bitsPerSample !== 16) {
    throw new Error('Only common WAV formats can be normalized to 16-bit PCM.');
  }

  if (![1, 2].includes(source.numChannels) || ![1, 2].includes(target.numChannels)) {
    throw new Error('Only mono and stereo PCM WAV normalization is supported.');
  }

  if (!target.sampleRate || !target.numChannels || !target.bitsPerSample) {
    throw new Error('A complete target PCM format is required for WAV normalization.');
  }

  const sourceBytesPerFrame = source.numChannels * (source.bitsPerSample / 8);
  const sourceFrameCount = Math.floor(source.data.length / sourceBytesPerFrame);
  if (sourceFrameCount <= 0) {
    return writeWavBuffer({
      sampleRate: target.sampleRate,
      bitsPerSample: target.bitsPerSample,
      numChannels: target.numChannels,
      data: Buffer.alloc(0),
    });
  }

  const targetFrameCount = Math.max(1, Math.round(sourceFrameCount * (target.sampleRate / source.sampleRate)));
  const output = Buffer.alloc(targetFrameCount * target.numChannels * 2);

  for (let targetFrameIndex = 0; targetFrameIndex < targetFrameCount; targetFrameIndex += 1) {
    const sourcePosition = targetFrameIndex * (source.sampleRate / target.sampleRate);
    const leftFrameIndex = Math.max(0, Math.min(sourceFrameCount - 1, Math.floor(sourcePosition)));
    const rightFrameIndex = Math.max(0, Math.min(sourceFrameCount - 1, Math.ceil(sourcePosition)));
    const interpolation = Math.max(0, Math.min(1, sourcePosition - leftFrameIndex));

    for (let targetChannelIndex = 0; targetChannelIndex < target.numChannels; targetChannelIndex += 1) {
      const leftSample = source.audioFormat === 1 && source.bitsPerSample === 16
        ? resolveInt16SampleForChannel(
          source.data,
          leftFrameIndex,
          source.numChannels,
          target.numChannels,
          targetChannelIndex,
        )
        : resolveInt16SampleForChannelFromFormat(source, leftFrameIndex, target.numChannels, targetChannelIndex);
      const rightSample = source.audioFormat === 1 && source.bitsPerSample === 16
        ? resolveInt16SampleForChannel(
          source.data,
          rightFrameIndex,
          source.numChannels,
          target.numChannels,
          targetChannelIndex,
        )
        : resolveInt16SampleForChannelFromFormat(source, rightFrameIndex, target.numChannels, targetChannelIndex);
      const interpolated = Math.round(leftSample + ((rightSample - leftSample) * interpolation));
      output.writeInt16LE(interpolated, ((targetFrameIndex * target.numChannels) + targetChannelIndex) * 2);
    }
  }

  return writeWavBuffer({
    sampleRate: target.sampleRate,
    bitsPerSample: target.bitsPerSample,
    numChannels: target.numChannels,
    data: output,
  });
}

function createSilenceWavBuffer(format, durationMs = 250) {
  const sampleRate = Number(format?.sampleRate || 0);
  const bitsPerSample = Number(format?.bitsPerSample || 0);
  const numChannels = Number(format?.numChannels || 0);
  if (!sampleRate || !bitsPerSample || !numChannels) {
    throw new Error('Cannot create silence without a valid WAV format.');
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameCount = Math.max(0, Math.round((sampleRate * Math.max(0, durationMs)) / 1000));
  const pcmData = Buffer.alloc(frameCount * numChannels * bytesPerSample, 0);
  return writeWavBuffer({
    sampleRate,
    bitsPerSample,
    numChannels,
    data: pcmData,
  });
}

function concatWavBuffers(buffers = []) {
  const parsedBuffers = (Array.isArray(buffers) ? buffers : [])
    .filter((buffer) => Buffer.isBuffer(buffer) && buffer.length > 0)
    .map((buffer) => parseWavBuffer(buffer));

  if (parsedBuffers.length === 0) {
    throw new Error('At least one WAV buffer is required to concatenate audio.');
  }

  const base = parsedBuffers[0];
  parsedBuffers.slice(1).forEach((entry) => {
    if (entry.audioFormat !== base.audioFormat
      || entry.numChannels !== base.numChannels
      || entry.sampleRate !== base.sampleRate
      || entry.bitsPerSample !== base.bitsPerSample) {
      throw new Error('All WAV buffers must share the same PCM format.');
    }
  });

  return writeWavBuffer({
    sampleRate: base.sampleRate,
    bitsPerSample: base.bitsPerSample,
    numChannels: base.numChannels,
    data: Buffer.concat(parsedBuffers.map((entry) => entry.data)),
  });
}

function applyWavEdgeFade(buffer, fadeMs = 8, options = {}) {
  const parsed = parseWavBuffer(buffer);
  if (parsed.audioFormat !== 1 || parsed.bitsPerSample !== 16) {
    return buffer;
  }

  const frameCount = Math.floor(parsed.data.length / (2 * parsed.numChannels));
  if (frameCount < 4) {
    return buffer;
  }
  const fadeFrames = Math.min(
    Math.floor(frameCount / 2),
    Math.max(0, Math.round((parsed.sampleRate * Math.max(0, Number(fadeMs) || 0)) / 1000)),
  );
  if (fadeFrames <= 0) {
    return buffer;
  }

  const fadeIn = options.fadeIn !== false;
  const fadeOut = options.fadeOut !== false;
  if (!fadeIn && !fadeOut) {
    return buffer;
  }

  const faded = Buffer.from(parsed.data);
  for (let frameIndex = 0; frameIndex < fadeFrames; frameIndex += 1) {
    const fadeInScale = frameIndex / fadeFrames;
    const fadeOutScale = frameIndex / fadeFrames;
    const fadeOutFrame = frameCount - 1 - frameIndex;

    for (let channelIndex = 0; channelIndex < parsed.numChannels; channelIndex += 1) {
      const inOffset = ((frameIndex * parsed.numChannels) + channelIndex) * 2;
      const outOffset = ((fadeOutFrame * parsed.numChannels) + channelIndex) * 2;
      if (fadeIn) {
        faded.writeInt16LE(Math.round(faded.readInt16LE(inOffset) * fadeInScale), inOffset);
      }
      if (fadeOut) {
        faded.writeInt16LE(Math.round(faded.readInt16LE(outOffset) * fadeOutScale), outOffset);
      }
    }
  }

  return writeWavBuffer({
    sampleRate: parsed.sampleRate,
    bitsPerSample: parsed.bitsPerSample,
    numChannels: parsed.numChannels,
    data: faded,
  });
}

module.exports = {
  applyWavEdgeFade,
  concatWavBuffers,
  createSilenceWavBuffer,
  normalizeWavBufferFormat,
  parseWavBuffer,
  wavFormatsMatch,
  writeWavBuffer,
};
