// Vercel Node.js function: Prometheus scrape endpoint.
// vercel.json rewrites `/metrics` -> `/api/metrics`; the shared handler normalises the
// path so the same code serves both entry points.

import { createHandler, getApp } from '../server/app.mjs';

export default createHandler(getApp());
