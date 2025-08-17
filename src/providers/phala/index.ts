import { ProviderConfigs } from '../types';
import PhalaApiConfig from './api';
import { PhalaChatCompleteConfig } from './chatComplete';
import { PhalaCompleteConfig } from './complete';

const PhalaConfig: ProviderConfigs = {
  complete: PhalaCompleteConfig,
  chatComplete: PhalaChatCompleteConfig,
  api: PhalaApiConfig,
};

export default PhalaConfig;
