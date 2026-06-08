const fs = require('fs/promises');
const { AudioProcessingService } = require('./audio-processing-service');
const { writeWavBuffer } = require('./wav-utils');

function createTestWav(bytes = [0, 0, 0, 0]) {
  return writeWavBuffer({
    sampleRate: 22050,
    bitsPerSample: 16,
    numChannels: 1,
    data: Buffer.from(bytes),
  });
}

function mockReadyAudioProcessing(service) {
  jest.spyOn(service, 'getDiagnostics').mockReturnValue({
    status: 'ready',
    supportsMp3: true,
    supportsMixing: true,
  });
}

describe('AudioProcessingService', () => {
  test('builds podcast mastering with hiss, click, and clipping repair filters', () => {
    const service = new AudioProcessingService({
      podcastMasteringLufs: -16,
      podcastMasteringTruePeakDb: -1.5,
    });

    const filter = service.buildPodcastMasteringFilter({ sampleRate: 22050, channelLayout: 'mono' });

    expect(filter).toContain('highpass=f=80');
    expect(filter).toContain('adeclick');
    expect(filter).toContain('adeclip');
    expect(filter).toContain('afftdn=nr=12:nf=-30:tn=1');
    expect(filter).toContain('deesser=i=0.25:m=0.5:f=0.5');
    expect(filter).toContain('lowpass=f=10000');
    expect(filter).toContain('loudnorm=I=-16:TP=-1.5:LRA=7');
    expect(filter).toContain('alimiter=limit=0.94');
    expect(filter).toContain('aresample=22050');
    expect(filter).toContain('aformat=sample_fmts=s16:channel_layouts=mono');
  });

  test('mixes podcast music bed with a valid amix duration mode', async () => {
    const speechWavBuffer = createTestWav();
    const service = new AudioProcessingService({
      enabled: true,
      ffmpegBinaryPath: 'ffmpeg',
      podcastMasteringEnabled: false,
    });
    mockReadyAudioProcessing(service);

    const runFfmpeg = jest.spyOn(service, 'runFfmpeg').mockImplementation(async (args) => {
      await fs.writeFile(args[args.length - 1], speechWavBuffer);
    });

    await service.composePodcastAudio({
      speechWavBuffer,
      includeMusicBed: true,
      musicBedPath: __filename,
      enhanceSpeech: false,
    });

    const mixArgs = runFfmpeg.mock.calls
      .map(([args]) => args)
      .find((args) => args.includes('-filter_complex') && args.join(' ').includes('[bed][program]'));
    const filterIndex = mixArgs.indexOf('-filter_complex') + 1;

    expect(mixArgs[filterIndex]).toContain('amix=inputs=2:duration=shortest');
    expect(mixArgs[filterIndex]).toContain('apad,atrim=0:');
    expect(mixArgs[filterIndex]).toContain('afade=t=in');
    expect(mixArgs[filterIndex]).toContain('afade=t=out');
    expect(mixArgs[filterIndex]).toContain('alimiter=limit=0.95');
    expect(mixArgs[filterIndex]).not.toContain('duration=second');
    expect(mixArgs).not.toEqual(expect.arrayContaining(['-stream_loop', '-1']));
  });

  test('synthesizes a fallback music bed when requested and no bed asset is configured', async () => {
    const speechWavBuffer = createTestWav();
    const service = new AudioProcessingService({
      enabled: true,
      ffmpegBinaryPath: 'ffmpeg',
      podcastMasteringEnabled: false,
    });
    mockReadyAudioProcessing(service);

    const runFfmpeg = jest.spyOn(service, 'runFfmpeg').mockImplementation(async (args) => {
      await fs.writeFile(args[args.length - 1], speechWavBuffer);
    });

    const result = await service.composePodcastAudio({
      speechWavBuffer,
      includeMusicBed: true,
      enhanceSpeech: false,
    });

    expect(result).toEqual(speechWavBuffer);
    expect(runFfmpeg).toHaveBeenCalledTimes(2);
    expect(runFfmpeg.mock.calls[0][0]).toEqual(expect.arrayContaining([
      '-f',
      'lavfi',
      expect.stringContaining('sine=frequency=220'),
    ]));
    const mixArgs = runFfmpeg.mock.calls[1][0];
    const filterIndex = mixArgs.indexOf('-filter_complex') + 1;
    expect(mixArgs[filterIndex]).toContain('[bed][program]amix=inputs=2:duration=shortest');
  });

  test('lays the music bed under the fully assembled intro, speech, and outro program', async () => {
    const speechWavBuffer = createTestWav();
    const service = new AudioProcessingService({
      enabled: true,
      ffmpegBinaryPath: 'ffmpeg',
      podcastMasteringEnabled: false,
      podcastIntroPath: __filename,
      podcastOutroPath: __filename,
      podcastMusicBedPath: __filename,
    });
    mockReadyAudioProcessing(service);

    const runFfmpeg = jest.spyOn(service, 'runFfmpeg').mockImplementation(async (args) => {
      await fs.writeFile(args[args.length - 1], speechWavBuffer);
    });

    await service.composePodcastAudio({
      speechWavBuffer,
      includeIntro: true,
      includeOutro: true,
      includeMusicBed: true,
      enhanceSpeech: false,
    });

    expect(runFfmpeg).toHaveBeenCalledTimes(2);
    const concatArgs = runFfmpeg.mock.calls[0][0];
    const mixArgs = runFfmpeg.mock.calls[1][0];
    const concatOutputPath = concatArgs[concatArgs.length - 1];
    const mixFilter = mixArgs[mixArgs.indexOf('-filter_complex') + 1];

    expect(concatArgs).toEqual(expect.arrayContaining([
      '-filter_complex',
      expect.stringContaining('concat=n=3:v=0:a=1'),
    ]));
    expect(mixArgs).toEqual(expect.arrayContaining(['-i', concatOutputPath]));
    expect(mixFilter).toContain('[bed][program]amix=inputs=2:duration=shortest');
    expect(mixFilter).toContain('afade=t=in');
    expect(mixFilter).toContain('afade=t=out');
  });

  test('allows explicit podcast mastering when default mastering is disabled', async () => {
    const speechWavBuffer = createTestWav();
    const service = new AudioProcessingService({
      enabled: true,
      ffmpegBinaryPath: 'ffmpeg',
      podcastMasteringEnabled: false,
    });
    mockReadyAudioProcessing(service);

    const runFfmpeg = jest.spyOn(service, 'runFfmpeg').mockImplementation(async (args) => {
      await fs.writeFile(args[args.length - 1], speechWavBuffer);
    });

    const result = await service.composePodcastAudio({
      speechWavBuffer,
      enhanceSpeech: true,
    });

    expect(result).toEqual(speechWavBuffer);
    expect(runFfmpeg).toHaveBeenCalledTimes(1);
    expect(runFfmpeg.mock.calls[0][0]).toEqual(expect.arrayContaining([
      '-af',
      expect.stringContaining('loudnorm='),
    ]));
  });
});
