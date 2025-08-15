export const createDefaultHeaders = (
  provider: string,
  authorization: string
) => {
  return {
    'x-redpill-provider': provider,
    Authorization: authorization,
    'Content-Type': 'application/json',
  };
};
