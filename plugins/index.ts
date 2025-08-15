import { handler as defaultlog } from './default/log';
import { handler as defaultmodelWhitelist } from './default/modelWhitelist';

export const plugins = {
  default: {
    log: defaultlog,
    modelWhitelist: defaultmodelWhitelist,
  },
};
