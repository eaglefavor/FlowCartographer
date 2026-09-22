// Vercel Node.js function: GraphQL endpoint.
// vercel.json rewrites `/graphql` -> `/api/graphql`; the shared handler normalises the
// path so the same code serves both entry points.

import { createHandler, getApp } from '../server/app.mjs';

export default createHandler(getApp());
