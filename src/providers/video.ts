import { ProviderConfig } from './types';

export const VideoSubmitConfig: ProviderConfig = {
  model: {
    param: 'model',
    required: true,
  },
  prompt: {
    param: 'prompt',
  },
  duration: {
    param: 'duration',
  },
  negative_prompt: {
    param: 'negative_prompt',
  },
  aspect_ratio: {
    param: 'aspect_ratio',
  },
  resolution: {
    param: 'resolution',
  },
  upscale_factor: {
    param: 'upscale_factor',
  },
  audio: {
    param: 'audio',
  },
  image_url: {
    param: 'image_url',
  },
  end_image_url: {
    param: 'end_image_url',
  },
  audio_url: {
    param: 'audio_url',
  },
  video_url: {
    param: 'video_url',
  },
  reference_image_urls: {
    param: 'reference_image_urls',
  },
  reference_video_urls: {
    param: 'reference_video_urls',
  },
  reference_audio_urls: {
    param: 'reference_audio_urls',
  },
  reference_video_total_duration: {
    param: 'reference_video_total_duration',
  },
  elements: {
    param: 'elements',
  },
  scene_image_urls: {
    param: 'scene_image_urls',
  },
};

export const VideoRetrieveConfig: ProviderConfig = {
  model: {
    param: 'model',
    required: true,
  },
  queue_id: {
    param: 'queue_id',
    required: true,
  },
  delete_media_on_completion: {
    param: 'delete_media_on_completion',
  },
};

export const VideoFileFetchConfig: ProviderConfig = {
  model: {
    param: 'model',
    required: true,
  },
  queue_id: {
    param: 'queue_id',
    required: true,
  },
};

export const VideoSubmitResponseTransform = <T extends any>(
  response: T,
  _responseStatus: number
): T => {
  if (
    response &&
    typeof response === 'object' &&
    'id' in response &&
    !('queue_id' in response)
  ) {
    return {
      ...response,
      queue_id: response.id,
    };
  }
  return response;
};

export const VideoResponseTransform = <T>(
  response: T,
  _responseStatus: number
): T => response;
