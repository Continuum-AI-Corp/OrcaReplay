#!/usr/bin/env node
/**
 * An agent that ignores every base-URL variable, for the capture-warning tests.
 *
 * This is not a contrived failure. An agent that never consults a base-URL variable does
 * exactly this under `orca record`: works perfectly, exits 0, and never once touches the
 * proxy. The run looks like a success from every angle except the one that matters, and the
 * trace is empty.
 */
console.log('deaf-agent: did some work without asking any model');
process.exit(0);
