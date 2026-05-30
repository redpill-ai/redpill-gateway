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
  VideoCompleteConfig,
  VideoQueueConfig,
  VideoQuoteConfig,
  VideoResponseTransform,
  VideoRetrieveConfig,
} from '../video';

const PhalaConfig: ProviderConfigs = {
  complete: PhalaCompleteConfig,
  embed: PhalaEmbedConfig,
  chatComplete: PhalaChatCompleteConfig,
  messages: OpenAIToAnthropicMessagesConfig,
  queueVideo: VideoQueueConfig,
  retrieveVideo: VideoRetrieveConfig,
  quoteVideo: VideoQuoteConfig,
  completeVideo: VideoCompleteConfig,
  api: PhalaApiConfig,
  responseTransforms: {
    messages: OpenAIToAnthropicMessagesResponseTransform,
    'stream-messages': OpenAIToAnthropicMessagesStreamTransform,
    queueVideo: VideoResponseTransform,
    retrieveVideo: VideoResponseTransform,
    quoteVideo: VideoResponseTransform,
    completeVideo: VideoResponseTransform,
  },
};

export default PhalaConfig;
