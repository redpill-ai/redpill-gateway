import { ProviderConfigs } from '../types';
import ChutesApiConfig from './api';
import { ChutesChatCompleteConfig } from './chatComplete';
import { ChutesCompleteConfig } from './complete';
import {
  OpenAIToAnthropicMessagesConfig,
  OpenAIToAnthropicMessagesResponseTransform,
  OpenAIToAnthropicMessagesStreamTransform,
} from '../openai-to-anthropic';

const ChutesConfig: ProviderConfigs = {
  complete: ChutesCompleteConfig,
  chatComplete: ChutesChatCompleteConfig,
  messages: OpenAIToAnthropicMessagesConfig,
  api: ChutesApiConfig,
  responseTransforms: {
    messages: OpenAIToAnthropicMessagesResponseTransform,
    'stream-messages': OpenAIToAnthropicMessagesStreamTransform,
  },
};

export default ChutesConfig;
