// A tiny concurrency limiter. A dashboard can have dozens of tiles, each
// wanting to run a Looker query on mount — firing them all at once overwhelms
// Looker's query concurrency and everything queues/stalls. This caps how many
// run simultaneously; the rest wait their turn.
const MAX_CONCURRENT = 5;

let active = 0;
const queue = [];

function next() {
  if (active >= MAX_CONCURRENT || queue.length === 0) return;
  active++;
  const { fn, resolve, reject } = queue.shift();
  Promise.resolve()
    .then(fn)
    .then(resolve, reject)
    .finally(() => {
      active--;
      next();
    });
}

// Run `fn` (which returns a promise) once a concurrency slot is free.
export function withLimit(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    next();
  });
}
