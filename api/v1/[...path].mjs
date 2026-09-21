// Vercel Node.js function: every /api/v1/* route of the FlowCartographer aggregator.
//
// `api/v1/[...path].mjs` is a catch-all, so the function receives the original request
// path (e.g. /api/v1/topology) in req.url and the shared handler can route on it exactly
// like the standalone `server/index.mjs` server does.

import { createHandler, getApp } from '../../server/app.mjs';

export default createHandler(getApp());
