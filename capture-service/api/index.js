'use strict';

// Vercel entrypoint. Every route is rewritten here (see vercel.json) and handed
// to the same Express app that `npm start` runs locally, so there is one
// implementation of the service rather than two that drift.
module.exports = require('../server.js');
