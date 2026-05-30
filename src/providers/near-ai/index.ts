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
  VideoCompleteConfig,
  VideoQueueConfig,
  VideoQuoteConfig,
  VideoResponseTransform,
  VideoRetrieveConfig,
} from '../video';

const NearAIConfig: ProviderConfigs = {
  complete: NearAICompleteConfig,
  chatComplete: NearAIChatCompleteConfig,
  messages: OpenAIToAnthropicMessagesConfig,
  queueVideo: VideoQueueConfig,
  retrieveVideo: VideoRetrieveConfig,
  quoteVideo: VideoQuoteConfig,
  completeVideo: VideoCompleteConfig,
  api: NearAIApiConfig,
  responseTransforms: {
    messages: OpenAIToAnthropicMessagesResponseTransform,
    'stream-messages': OpenAIToAnthropicMessagesStreamTransform,
    queueVideo: VideoResponseTransform,
    retrieveVideo: VideoResponseTransform,
    quoteVideo: VideoResponseTransform,
    completeVideo: VideoResponseTransform,
  },
};

export default NearAIConfig;
