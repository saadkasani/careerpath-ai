// Netlify Blobs access. connectLambda wires the function event to the Blobs service.
const { connectLambda, getStore } = require('@netlify/blobs');

function stores(event) {
  connectLambda(event);
  return { jobs: getStore('jobs'), limits: getStore('limits') };
}

module.exports = { stores };
