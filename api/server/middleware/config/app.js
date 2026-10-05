const axios = require('axios');
const { createConfigMiddleware, createEndpointGroupsResolver } = require('@librechat/api');
const { getAppConfig } = require('~/server/services/Config');

module.exports = createConfigMiddleware({
  getAppConfig,
  resolveEndpointGroups: createEndpointGroupsResolver({
    request: async (options) => (await axios.get(options.url, options)).data,
  }),
});
