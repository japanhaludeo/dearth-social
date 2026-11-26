'use strict';

const express = require('express');
const serverless = require('serverless-http');
const app = require('../../server');

// Rewrite /api/* through this mount point to retain the Express app's existing
// /api routes while Netlify routes requests into this function.
const functionApp = express();
functionApp.use('/.netlify/functions/api', app);

exports.handler = serverless(functionApp);
