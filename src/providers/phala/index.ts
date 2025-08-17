import { ProviderConfigs } from '../types';
import PhalaApiConfig from './api';
import {
  PhalaChatCompleteConfig,
  PhalaChatCompleteResponseTransform,
  PhalaChatCompleteStreamChunkTransform,
} from './chatComplete';
import {
  PhalaCompleteConfig,
  PhalaCompleteResponseTransform,
  PhalaCompleteStreamChunkTransform,
} from './complete';

const PhalaConfig: ProviderConfigs = {
  complete: PhalaCompleteConfig,
  chatComplete: PhalaChatCompleteConfig,
  api: PhalaApiConfig,
  responseTransforms: {
    'stream-complete': PhalaCompleteStreamChunkTransform,
    complete: PhalaCompleteResponseTransform,
    chatComplete: PhalaChatCompleteResponseTransform,
    'stream-chatComplete': PhalaChatCompleteStreamChunkTransform,
  },
};

export default PhalaConfig;
