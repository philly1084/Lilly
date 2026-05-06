const fsSync = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { config } = require('../config');
const { parseWavBuffer } = require('./wav-utils');
let ffmpegStaticPath = '';
try {
  ffmpegStaticPath = require('ffmpeg-static') || '';
} catch (_error) {
  ffmpegStaticPath = '';
}

function createServiceError(statusCode, message, code = 'audio_processing_error') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function isExplicitPath(value = '') {
  const normalized = String(value || '').trim();
  return Boolean(normalized)
    && (path.isAbsolute(normalized)
      || normalized.includes('/')
      || normalized.includes('\\')
      || /\.[a-z0-9]+$/i.test(normalized));
}

function escapeFilterValue(value = '') {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/,/g, '\\,');
}

function channelLayoutFor(numChannels = 1) {
  return Number(numChannels) === 2 ? 'stereo' : 'mono';
}

class AudioProcessingService {
  constructor(audioProcessingConfig = config.audioProcessing || {}, dependencies = {}) {
    this.audioProcessingConfig = {
      ...audioProcessingConfig,
    };
    this.spawn = dependencies.spawn || spawn;
    this.spawnSync = dependencies.spawnSync || spawnSync;
  }

  updateConfig(patch = {}) {
    this.audioProcessingConfig = {
      ...this.audioProcessingConfig,
      ...(patch || {}),
    };
  }

  getEffectiveBinaryPath() {
    const configured = String(this.audioProcessingConfig.ffmpegBinaryPath || '').trim();
    if (configured && configured !== 'ffmpeg') {
      return configured;
    }

    if (ffmpegStaticPath) {
      return ffmpegStaticPath;
    }

    return configured || 'ffmpeg';
  }

  pathExists(targetPath = '') {
    const normalized = String(targetPath || '').trim();
    if (!normalized) {
      return false;
    }

    if (!isExplicitPath(normalized)) {
      return true;
    }

    try {
      return fsSync.existsSync(normalized);
    } catch (_error) {
      return false;
    }
  }

  getDiagnostics() {
    const enabled = this.audioProcessingConfig.enabled !== false;
    const binaryPath = this.getEffectiveBinaryPath();
    if (!enabled) {
      return {
        status: 'unavailable',
        binaryReachable: false,
        supportsMp3: false,
        supportsMixing: false,
        message: 'Audio post-processing is disabled.',
      };
    }

    if (!binaryPath) {
      return {
        status: 'misconfigured',
        binaryReachable: false,
        supportsMp3: false,
        supportsMixing: false,
        message: 'No ffmpeg binary path is configured.',
      };
    }

    if (isExplicitPath(binaryPath) && !this.pathExists(binaryPath)) {
      return {
        status: 'misconfigured',
        binaryReachable: false,
        supportsMp3: false,
        supportsMixing: false,
        message: `ffmpeg is missing at "${binaryPath}".`,
      };
    }

    try {
      const result = this.spawnSync(binaryPath, ['-version'], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
      if (result?.error) {
        throw result.error;
      }
      if (typeof result?.status === 'number' && result.status !== 0) {
        throw new Error(result.stderr || result.stdout || `ffmpeg exited with code ${result.status}.`);
      }

      return {
        status: 'ready',
        binaryReachable: true,
        supportsMp3: true,
        supportsMixing: true,
        message: 'ffmpeg audio post-processing is ready.',
      };
    } catch (error) {
      return {
        status: 'misconfigured',
        binaryReachable: false,
        supportsMp3: false,
        supportsMixing: false,
        message: error?.message || 'ffmpeg is not reachable.',
      };
    }
  }

  getPublicConfig() {
    const diagnostics = this.getDiagnostics();
    return {
      configured: diagnostics.status === 'ready',
      provider: 'ffmpeg',
      diagnostics,
      supportsMp3: diagnostics.supportsMp3 === true,
      supportsMixing: diagnostics.supportsMixing === true,
      defaults: {
        introPathConfigured: Boolean(this.audioProcessingConfig.podcastIntroPath),
        outroPathConfigured: Boolean(this.audioProcessingConfig.podcastOutroPath),
        musicBedPathConfigured: Boolean(this.audioProcessingConfig.podcastMusicBedPath),
        masteringEnabled: this.audioProcessingConfig.podcastMasteringEnabled !== false,
        masteringLufs: Number.isFinite(Number(this.audioProcessingConfig.podcastMasteringLufs))
          ? Number(this.audioProcessingConfig.podcastMasteringLufs)
          : -16,
        mp3BitrateKbps: Math.max(64, Number(this.audioProcessingConfig.mp3BitrateKbps) || 192),
      },
    };
  }

  buildPodcastMasteringFilter({ sampleRate = null, channelLayout = '' } = {}) {
    const targetLufs = Number.isFinite(Number(this.audioProcessingConfig.podcastMasteringLufs))
      ? Number(this.audioProcessingConfig.podcastMasteringLufs)
      : -16;
    const truePeakDb = Number.isFinite(Number(this.audioProcessingConfig.podcastMasteringTruePeakDb))
      ? Number(this.audioProcessingConfig.podcastMasteringTruePeakDb)
      : -1.5;
    const requestedSampleRate = Number(sampleRate);
    const lowpassFrequency = Number.isFinite(requestedSampleRate) && requestedSampleRate > 0
      ? Math.max(3000, Math.min(10000, Math.floor((requestedSampleRate / 2) - 200)))
      : 10000;
    const outputFilters = [];
    if (Number.isFinite(requestedSampleRate) && requestedSampleRate > 0) {
      outputFilters.push(`aresample=${Math.round(requestedSampleRate)}`);
    }
    if (channelLayout) {
      outputFilters.push(`aformat=sample_fmts=s16:channel_layouts=${channelLayout}`);
    }

    return [
      'highpass=f=80',
      'adeclick',
      'adeclip',
      'afftdn=nr=12:nf=-30:tn=1',
      'deesser=i=0.25:m=0.5:f=0.5',
      `lowpass=f=${lowpassFrequency}`,
      `loudnorm=I=${targetLufs}:TP=${truePeakDb}:LRA=7`,
      'alimiter=limit=0.94',
      ...outputFilters,
    ].join(',');
  }

  assertConfigured() {
    const diagnostics = this.getDiagnostics();
    if (diagnostics.status === 'ready') {
      return;
    }

    throw createServiceError(
      503,
      diagnostics.message || 'Audio post-processing is unavailable.',
      'audio_processing_unavailable',
    );
  }

  resolveAssetPath(requestedPath = '', configuredPath = '', label = 'audio asset') {
    const candidate = String(requestedPath || configuredPath || '').trim();
    if (!candidate) {
      return '';
    }

    const resolved = path.resolve(candidate);
    if (!fsSync.existsSync(resolved)) {
      throw createServiceError(400, `${label} was not found at "${resolved}".`, 'audio_asset_missing');
    }

    return resolved;
  }

  async runFfmpeg(args = [], errorCode = 'audio_processing_failed', failureMessage = 'ffmpeg failed.') {
    this.assertConfigured();
    const binaryPath = this.getEffectiveBinaryPath();

    return new Promise((resolve, reject) => {
      const stderr = [];
      const stdout = [];
      const child = this.spawn(binaryPath, args, {
        windowsHide: true,
      });

      const timeoutMs = Math.max(1000, Number(this.audioProcessingConfig.timeoutMs) || 90000);
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(createServiceError(504, 'ffmpeg timed out while processing audio.', 'audio_processing_timeout'));
      }, timeoutMs);

      child.stdout?.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));

      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(createServiceError(503, error.message || 'ffmpeg could not be started.', 'audio_processing_unavailable'));
      });

      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve({
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
          });
          return;
        }

        reject(createServiceError(
          502,
          `${failureMessage} ${Buffer.concat(stderr).toString('utf8').trim()}`.trim(),
          errorCode,
        ));
      });
    });
  }

  async transcodeWavToMp3({ wavBuffer, bitrateKbps } = {}) {
    if (!Buffer.isBuffer(wavBuffer) || wavBuffer.length === 0) {
      throw createServiceError(400, 'A WAV buffer is required for MP3 transcoding.', 'audio_processing_invalid_input');
    }

    this.assertConfigured();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimibuilt-podcast-mp3-'));
    const inputPath = path.join(tempDir, 'episode.wav');
    const outputPath = path.join(tempDir, 'episode.mp3');
    const bitrate = Math.max(64, Number(bitrateKbps || this.audioProcessingConfig.mp3BitrateKbps) || 192);

    try {
      await fs.writeFile(inputPath, wavBuffer);
      await this.runFfmpeg([
        '-y',
        '-i', inputPath,
        '-codec:a', 'libmp3lame',
        '-b:a', `${bitrate}k`,
        outputPath,
      ], 'audio_mp3_export_failed', 'ffmpeg failed to export MP3.');
      return await fs.readFile(outputPath);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  async generateCalmMusicBed({ outputPath, durationSeconds = 0, sampleRate = 22050, channelLayout = 'mono' } = {}) {
    const duration = Math.max(1, Number(durationSeconds) || 1);
    const fadeOutStart = Math.max(0, duration - 3);
    await this.runFfmpeg([
      '-y',
      '-f', 'lavfi',
      '-i', `sine=frequency=220:sample_rate=${sampleRate}:duration=${duration.toFixed(3)}`,
      '-f', 'lavfi',
      '-i', `sine=frequency=277:sample_rate=${sampleRate}:duration=${duration.toFixed(3)}`,
      '-filter_complex', [
        '[0:a]volume=0.32[a0]',
        '[1:a]volume=0.18[a1]',
        '[a0][a1]amix=inputs=2:duration=longest:dropout_transition=0',
        'lowpass=f=1800',
        'afade=t=in:st=0:d=2',
        `afade=t=out:st=${fadeOutStart.toFixed(3)}:d=3`,
        `aformat=sample_fmts=s16:channel_layouts=${channelLayout}`,
      ].join(','),
      '-c:a', 'pcm_s16le',
      outputPath,
    ], 'audio_bed_generate_failed', 'ffmpeg failed to generate the podcast music bed.');
  }

  async composePodcastAudio({
    speechWavBuffer,
    includeIntro = false,
    includeOutro = false,
    includeMusicBed = false,
    enhanceSpeech = null,
    introPath = '',
    outroPath = '',
    musicBedPath = '',
    speechVolume,
    musicVolume,
    introVolume,
    outroVolume,
  } = {}) {
    if (!Buffer.isBuffer(speechWavBuffer) || speechWavBuffer.length === 0) {
      throw createServiceError(400, 'A speech WAV buffer is required for podcast composition.', 'audio_processing_invalid_input');
    }

    const shouldEnhanceSpeech = enhanceSpeech === true
      ? true
      : enhanceSpeech === false
        ? false
        : this.audioProcessingConfig.podcastMasteringEnabled !== false;
    const needsMix = includeIntro || includeOutro || includeMusicBed || introPath || outroPath || musicBedPath;
    if (!needsMix && !shouldEnhanceSpeech) {
      return speechWavBuffer;
    }

    this.assertConfigured();
    const format = parseWavBuffer(speechWavBuffer);
    const sampleRate = format.sampleRate;
    const channelLayout = channelLayoutFor(format.numChannels);
    const speechLevel = Number.isFinite(Number(speechVolume))
      ? Number(speechVolume)
      : (Number(this.audioProcessingConfig.podcastSpeechVolume) || 1);
    const introLevel = Number.isFinite(Number(introVolume))
      ? Number(introVolume)
      : (Number(this.audioProcessingConfig.podcastIntroVolume) || 1);
    const outroLevel = Number.isFinite(Number(outroVolume))
      ? Number(outroVolume)
      : (Number(this.audioProcessingConfig.podcastOutroVolume) || 1);
    const bedLevel = Number.isFinite(Number(musicVolume))
      ? Number(musicVolume)
      : (Number(this.audioProcessingConfig.podcastMusicVolume) || 0.07);
    const resolvedIntroPath = (includeIntro || Boolean(String(introPath || '').trim()))
      ? this.resolveAssetPath(introPath, this.audioProcessingConfig.podcastIntroPath, 'Podcast intro audio')
      : '';
    const resolvedOutroPath = (includeOutro || Boolean(String(outroPath || '').trim()))
      ? this.resolveAssetPath(outroPath, this.audioProcessingConfig.podcastOutroPath, 'Podcast outro audio')
      : '';
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kimibuilt-podcast-compose-'));
    const speechPath = path.join(tempDir, 'speech.wav');
    const mixedSpeechPath = path.join(tempDir, 'speech-mixed.wav');
    const finalPath = path.join(tempDir, 'podcast-final.wav');
    const masteredPath = path.join(tempDir, 'podcast-mastered.wav');
    const generatedBedPath = path.join(tempDir, 'generated-music-bed.wav');

    try {
      await fs.writeFile(speechPath, speechWavBuffer);
      let currentPath = speechPath;
      let resolvedBedPath = '';
      const bytesPerSample = Math.max(1, Math.floor(format.bitsPerSample / 8));
      const durationSeconds = format.data.length / Math.max(1, sampleRate * format.numChannels * bytesPerSample);
      if (includeMusicBed || Boolean(String(musicBedPath || '').trim())) {
        const requestedBedPath = String(musicBedPath || '').trim();
        const configuredBedPath = String(this.audioProcessingConfig.podcastMusicBedPath || '').trim();
        resolvedBedPath = requestedBedPath || configuredBedPath
          ? this.resolveAssetPath(
            requestedBedPath,
            configuredBedPath,
            'Podcast music bed audio',
          )
          : '';
        if (!resolvedBedPath && includeMusicBed) {
          await this.generateCalmMusicBed({
            outputPath: generatedBedPath,
            durationSeconds,
            sampleRate,
            channelLayout,
          });
          resolvedBedPath = generatedBedPath;
        }
      }

      if (resolvedBedPath) {
        const fadeOutStart = Math.max(0, durationSeconds - 2);
        const filter = [
          `[0:a]volume=${escapeFilterValue(bedLevel)},aresample=${sampleRate},aformat=sample_fmts=s16:channel_layouts=${channelLayout},apad,atrim=0:${durationSeconds.toFixed(3)},afade=t=in:st=0:d=1,afade=t=out:st=${fadeOutStart.toFixed(3)}:d=2[bed]`,
          `[1:a]volume=${escapeFilterValue(speechLevel)},aresample=${sampleRate},aformat=sample_fmts=s16:channel_layouts=${channelLayout}[speech]`,
          '[bed][speech]amix=inputs=2:duration=shortest:dropout_transition=0:normalize=0[mixed]',
          '[mixed]alimiter=limit=0.95[a]',
        ].join(';');

        await this.runFfmpeg([
          '-y',
          '-i', resolvedBedPath,
          '-i', speechPath,
          '-filter_complex', filter,
          '-map', '[a]',
          '-c:a', 'pcm_s16le',
          mixedSpeechPath,
        ], 'audio_mix_failed', 'ffmpeg failed to mix the podcast music bed.');
        currentPath = mixedSpeechPath;
      }

      const concatInputs = [];
      const concatLevels = [];
      if (resolvedIntroPath) {
        concatInputs.push(resolvedIntroPath);
        concatLevels.push(introLevel);
      }
      concatInputs.push(currentPath);
      concatLevels.push(speechLevel);
      if (resolvedOutroPath) {
        concatInputs.push(resolvedOutroPath);
        concatLevels.push(outroLevel);
      }

      let assembledPath = currentPath;
      if (concatInputs.length > 1) {
        const filterParts = concatInputs.map((_, index) => (
          `[${index}:a]volume=${escapeFilterValue(concatLevels[index])},aresample=${sampleRate},aformat=sample_fmts=s16:channel_layouts=${channelLayout}[a${index}]`
        ));
        const concatRefs = concatInputs.map((_, index) => `[a${index}]`).join('');
        filterParts.push(`${concatRefs}concat=n=${concatInputs.length}:v=0:a=1[a]`);

        const args = ['-y'];
        concatInputs.forEach((inputPath) => {
          args.push('-i', inputPath);
        });
        args.push(
          '-filter_complex', filterParts.join(';'),
          '-map', '[a]',
          '-c:a', 'pcm_s16le',
          finalPath,
        );

        await this.runFfmpeg(args, 'audio_concat_failed', 'ffmpeg failed to assemble the podcast intro/outro.');
        assembledPath = finalPath;
      }

      if (!shouldEnhanceSpeech) {
        return await fs.readFile(assembledPath);
      }

      await this.runFfmpeg([
        '-y',
        '-i', assembledPath,
        '-af', this.buildPodcastMasteringFilter({ sampleRate, channelLayout }),
        '-c:a', 'pcm_s16le',
        masteredPath,
      ], 'audio_mastering_failed', 'ffmpeg failed to master the podcast audio.');
      return await fs.readFile(masteredPath);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}

const audioProcessingService = new AudioProcessingService();

module.exports = {
  AudioProcessingService,
  audioProcessingService,
  createServiceError,
};
