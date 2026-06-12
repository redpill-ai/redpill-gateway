import { ProviderConfigs } from '../types';
import ChutesApiConfig from './api';
import { ChutesChatCompleteConfig } from './chatComplete';
import { ChutesCompleteConfig } from './complete';
import { ChutesEmbedConfig } from './embed';
import { createExtraFieldStripper } from '../utils';
import {
  OpenAIToAnthropicMessagesConfig,
  OpenAIToAnthropicMessagesResponseTransform,
  OpenAIToAnthropicMessagesStreamTransform,
} from '../openai-to-anthropic';

// Non-standard top-level fields chutes adds to OpenAI-compatible responses that
// should not be forwarded to the user. Present on both the non-streaming body
// and (chutes_verification + the sha256s) on every streaming chunk.
const ChutesExtraFields = [
  'chutes_verification',
  'template_sha256',
  'prompt_sha256',
  'metadata',
];
const {
  chatComplete: ChutesStripChatComplete,
  streamChatComplete: ChutesStripStreamChatComplete,
} = createExtraFieldStripper(ChutesExtraFields);

const ChutesConfig: ProviderConfigs = {
  complete: ChutesCompleteConfig,
  chatComplete: ChutesChatCompleteConfig,
  embed: ChutesEmbedConfig,
  messages: OpenAIToAnthropicMessagesConfig,
  api: ChutesApiConfig,
  responseTransforms: {
    chatComplete: ChutesStripChatComplete,
    'stream-chatComplete': ChutesStripStreamChatComplete,
    messages: OpenAIToAnthropicMessagesResponseTransform,
    'stream-messages': OpenAIToAnthropicMessagesStreamTransform,
  },
};

export default ChutesConfig;
