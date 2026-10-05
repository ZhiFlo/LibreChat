const express = require('express');
const { modelController } = require('~/server/controllers/ModelController');
const { requireJwtAuth, configMiddleware } = require('~/server/middleware/');

const router = express.Router();
router.get('/', requireJwtAuth, configMiddleware, modelController);

module.exports = router;
