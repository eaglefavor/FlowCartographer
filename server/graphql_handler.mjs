// FlowCartographer Lightweight GraphQL Resolver Engine
// Resolves queries specified in Section 6.1 of the Blueprint

export function handleGraphQLQuery(queryText, variables = {}, graphEngine, store) {
  if (!queryText || typeof queryText !== 'string') {
    return { errors: [{ message: 'Empty or invalid GraphQL query' }] };
  }

  const cleanQuery = queryText.replace(/\s+/g, ' ').trim();

  try {
    const data = {};

    // 1. Query: topology(namespace: ...)
    if (cleanQuery.includes('topology')) {
      let ns = variables.namespace || null;
      const match = cleanQuery.match(/topology\s*\(\s*namespace\s*:\s*["']?([^"')\s]+)["']?\s*\)/);
      if (match) {
        ns = match[1];
      }
      data.topology = graphEngine.getTopology(ns);
    }

    // 2. Query: blastRadius(nodeId: ...)
    if (cleanQuery.includes('blastRadius')) {
      let nodeId = variables.nodeId || null;
      const match = cleanQuery.match(/blastRadius\s*\(\s*nodeId\s*:\s*["']?([^"')\s]+)["']?\s*\)/);
      if (match) {
        nodeId = match[1];
      }
      if (nodeId) {
        data.blastRadius = graphEngine.computeBlastRadius(nodeId);
      } else {
        data.blastRadius = null;
      }
    }

    // 3. Query: node(id: ...)
    if (cleanQuery.includes('node(') || cleanQuery.includes('node (')) {
      let nodeId = variables.id || null;
      const match = cleanQuery.match(/node\s*\(\s*id\s*:\s*["']?([^"')\s]+)["']?\s*\)/);
      if (match) {
        nodeId = match[1];
      }
      data.node = nodeId ? graphEngine.nodes.get(nodeId) || null : null;
    }

    // 4. Query: historicalSnapshots
    if (cleanQuery.includes('historicalSnapshots')) {
      data.historicalSnapshots = store.getSnapshots(15);
    }

    return { data };
  } catch (err) {
    return { errors: [{ message: err.message }] };
  }
}
