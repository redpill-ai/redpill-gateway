import { ProviderConfig } from '../types';

export const PhalaEmbedConfig: ProviderConfig = {
  model: {
    param: 'model',
    required: true,
  },
  input: {
    param: 'input',
    required: true,
  },
  encoding_format: {
    param: 'encoding_format',
  },
  dimensions: {
    param: 'dimensions',
  },
  user: {
    param: 'user',
  },
};
