import { ProviderConfigs } from '../types';
import NearAIApiConfig from './api';
import { NearAIChatCompleteConfig } from './chatComplete';
import { NearAICompleteConfig } from './complete';
import {
  OpenAIToAnthropicMessagesConfig,
  OpenAIToAnthropicMessagesResponseTransform,
  OpenAIToAnthropicMessagesStreamTransform,
} from '../openai-to-anthropic';
import {
  VideoFileFetchConfig,
  VideoResponseTransform,
  VideoRetrieveConfig,
  VideoSubmitResponseTransform,
  VideoSubmitConfig,
} from '../video';

const NearAIConfig: ProviderConfigs = {
  complete: NearAICompleteConfig,
  chatComplete: NearAIChatCompleteConfig,
  messages: OpenAIToAnthropicMessagesConfig,
  submitVideo: VideoSubmitConfig,
  retrieveVideo: VideoRetrieveConfig,
  fetchVideoFile: VideoFileFetchConfig,
  api: NearAIApiConfig,
  responseTransforms: {
    messages: OpenAIToAnthropicMessagesResponseTransform,
    'stream-messages': OpenAIToAnthropicMessagesStreamTransform,
    submitVideo: VideoSubmitResponseTransform,
    retrieveVideo: VideoResponseTransform,
    fetchVideoFile: VideoResponseTransform,
  },
};

export default NearAIConfig;
