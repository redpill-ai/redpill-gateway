import PhalaApiConfig from '../phala/api';
import { VideoRetrieveConfig, VideoSubmitConfig } from '../video';
import { Params } from '../../types/requestBody';
import { Options } from '../../types/requestBody';

const transform = (
  providerConfig: any,
  params: Params,
  providerOptions: Options
) => {
  process.env.DATABASE_URL ||= 'postgres://test';
  process.env.CLICKHOUSE_URL ||= 'http://localhost:8123';
  process.env.CLICKHOUSE_USERNAME ||= 'default';
  process.env.CLICKHOUSE_PASSWORD ||= 'password';
  process.env.CLICKHOUSE_DATABASE ||= 'default';
  process.env.ENCRYPTION_KEY ||=
    '0000000000000000000000000000000000000000000000000000000000000000';

  const {
    transformUsingProviderConfig,
  } = require('../../services/transformToProviderRequest');
  return transformUsingProviderConfig(providerConfig, params, providerOptions);
};

describe('video provider format', () => {
  it('maps phala custom-host video endpoints', () => {
    const baseArgs = {
      c: {} as any,
      providerOptions: { provider: 'phala', apiKey: 'test-key' },
      gatewayRequestBody: {},
      gatewayRequestBodyJSON: {
        id: 'video-job-123',
      },
      gatewayRequestURL: 'https://gateway.example.com/v1/videos',
    };

    expect(PhalaApiConfig.getEndpoint({ ...baseArgs, fn: 'submitVideo' })).toBe(
      '/v1/videos'
    );
    expect(
      PhalaApiConfig.getEndpoint({ ...baseArgs, fn: 'retrieveVideo' })
    ).toBe('/v1/videos/video-job-123');
    expect(
      PhalaApiConfig.getEndpoint({ ...baseArgs, fn: 'fetchVideoFile' })
    ).toBe('/v1/videos/video-job-123/file');
  });

  it('passes video submit fields through without provider-specific rewrites', () => {
    const request = {
      model: 'seedance-2-0-reference-to-video',
      prompt: 'Refer to <Subject 1> in <Image 1> walking at night.',
      duration: '5s',
      negative_prompt: 'low quality',
      aspect_ratio: '9:16',
      resolution: '1080p',
      upscale_factor: 2,
      audio: true,
      image_url: 'data:image/png;base64,abc',
      end_image_url: 'data:image/png;base64,def',
      audio_url: 'data:audio/mpeg;base64,ghi',
      video_url: 'data:video/mp4;base64,jkl',
      reference_image_urls: ['https://example.com/character.png'],
      reference_video_urls: ['https://example.com/motion.mp4'],
      reference_audio_urls: ['https://example.com/voice.mp3'],
      reference_video_total_duration: 4,
      elements: [{ reference_image_urls: ['https://example.com/ref.png'] }],
      scene_image_urls: ['https://example.com/scene.png'],
    };

    expect(
      transform(VideoSubmitConfig, request, {
        provider: 'phala',
      })
    ).toEqual(request);
  });

  it('maps retrieve by model, queue_id, and cleanup preference', () => {
    const request = {
      model: 'seedance-2-0-text-to-video',
      queue_id: '123e4567-e89b-12d3-a456-426614174000',
      delete_media_on_completion: false,
      ignored: true,
    };

    expect(
      transform(VideoRetrieveConfig, request, {
        provider: 'phala',
      })
    ).toEqual({
      model: request.model,
      queue_id: request.queue_id,
      delete_media_on_completion: request.delete_media_on_completion,
    });
  });
});
