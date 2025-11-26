import { ProviderConfigs } from '../types';
import TinfoilApiConfig from './api';
import { TinfoilChatCompleteConfig } from './chatComplete';
import { TinfoilCompleteConfig } from './complete';

const TinfoilConfig: ProviderConfigs = {
  complete: TinfoilCompleteConfig,
  chatComplete: TinfoilChatCompleteConfig,
  api: TinfoilApiConfig,
};

export default TinfoilConfig;
