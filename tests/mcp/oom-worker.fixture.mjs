// Stands in for pdf-worker.mjs and runs out of memory under the real resource limits.
const hold = [];
for (;;) hold.push(new Array(1_000_000).fill({}));
