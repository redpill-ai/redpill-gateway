import { ProviderConfigs } from '../types';
import PhalaApiConfig from './api';
import { PhalaChatCompleteConfig } from './chatComplete';
import { PhalaCompleteConfig } from './complete';
import { PhalaEmbedConfig } from './embed';
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

const PhalaConfig: ProviderConfigs = {
  complete: PhalaCompleteConfig,
  embed: PhalaEmbedConfig,
  chatComplete: PhalaChatCompleteConfig,
  messages: OpenAIToAnthropicMessagesConfig,
  submitVideo: VideoSubmitConfig,
  retrieveVideo: VideoRetrieveConfig,
  fetchVideoFile: VideoFileFetchConfig,
  api: PhalaApiConfig,
  responseTransforms: {
    messages: OpenAIToAnthropicMessagesResponseTransform,
    'stream-messages': OpenAIToAnthropicMessagesStreamTransform,
    submitVideo: VideoSubmitResponseTransform,
    retrieveVideo: VideoResponseTransform,
    fetchVideoFile: VideoResponseTransform,
  },
};

export default PhalaConfig;
