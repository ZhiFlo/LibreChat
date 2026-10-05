import { logger } from '@librechat/data-schemas';
import type { AppConfig } from '@librechat/data-schemas';
import type { Response, NextFunction } from 'express';
import type { GetAppConfigOptions } from '~/app/service';
import type { ServerRequest } from '~/types';
import { getAppConfigOptionsFromUser } from '~/app/service';
import { getSafeErrorMetadata } from '~/utils/errors';

export function createConfigMiddleware(deps: {
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig>;
  resolveEndpointGroups: (req: ServerRequest, config: AppConfig) => Promise<AppConfig>;
}): (req: ServerRequest, res: Response, next: NextFunction) => Promise<void> {
  return async (req: ServerRequest, _res: Response, next: NextFunction): Promise<void> => {
    try {
      let config: AppConfig;
      try {
        config = await deps.getAppConfig(getAppConfigOptionsFromUser(req.user));
      } catch (error) {
        logger.error('Config middleware error:', getSafeErrorMetadata(error));
        config = await deps.getAppConfig({ tenantId: req.user?.tenantId });
      }
      req.config = await deps.resolveEndpointGroups(req, config);
      next();
    } catch (error) {
      // Discovery failures must not fall back to another account's models.
      next(error);
    }
  };
}
