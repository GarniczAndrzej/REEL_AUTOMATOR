export const queue = {
  jobs: [],
  concurrency: 2,
};

let _rerenderFn = null;
let _unlistenProgress = null;
let _isRunning = false;

export function setRerenderFn(fn) {
  _rerenderFn = fn;
}

function rerenderQueue() {
  if (_rerenderFn) _rerenderFn();
}

export async function initQueue() {
  if (_unlistenProgress) {
    _unlistenProgress();
    _unlistenProgress = null;
  }
  try {
    const { listen } = await import('@tauri-apps/api/event');
    _unlistenProgress = await listen('render-progress', (e) => {
      const job = queue.jobs.find((j) => j.id === e.payload.reel_id);
      if (job) job.percent = e.payload.percent;
      rerenderQueue();
    });
  } catch {}
}

// ── F13 — Queue persistence ────────────────────────────────────────────

function persistQueue() {
  const serializable = queue.jobs
    .filter((j) => j.status === 'pending' || j.status === 'running')
    .map((j) => ({
      id: j.id,
      reelIdx: j.reelIdx,
      reelName: j.reelName,
      aspect: j.aspect,
      status: 'pending',
      percent: 0,
      error: null,
      outPath: null,
      req: j.req,
    }));
  import('@tauri-apps/api/core')
    .then(({ invoke }) =>
      invoke('save_render_queue', {
        content: JSON.stringify(serializable),
      }).catch((e) => {
        console.warn('Failed to persist render queue:', e);
      }),
    )
    .catch(() => {});
}

export async function clearSavedQueue() {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('save_render_queue', { content: '[]' });
}

// Called by main.js on startup: returns pending jobs if any, else null.
export async function loadSavedQueue() {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const data = await invoke('load_render_queue');
    if (!data) return null;
    const jobs = JSON.parse(data);
    const pending = jobs.filter((j) => j.status === 'pending');
    return pending.length ? pending : null;
  } catch {
    return null;
  }
}

// Resume with pre-built job list (used by F13 banner).
export function resumeQueue(jobs) {
  queue.jobs = jobs.map((j) => ({ ...j, status: 'pending', percent: 0 }));
  rerenderQueue();
  runQueue().finally(() => {
    rerenderQueue();
    persistQueue();
  });
}

export async function enqueueAll(jobs) {
  if (_isRunning) {
    for (const j of jobs) {
      if (!queue.jobs.find((x) => x.id === j.id)) queue.jobs.push(j);
    }
    rerenderQueue();
    return;
  }
  // Preserve already-finished jobs; only add/replace pending ones
  const finished = queue.jobs.filter(
    (j) =>
      j.status === 'done' || j.status === 'cancelled' || j.status === 'error',
  );
  const newJobs = jobs.filter((j) => !finished.find((x) => x.id === j.id));
  queue.jobs = [...finished, ...newJobs];
  rerenderQueue();
  persistQueue();
  await runQueue();
  rerenderQueue();
}

async function runQueue() {
  _isRunning = true;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const inflight = new Set();
    let cursor = 0;

    while (true) {
      // Drain until below concurrency limit
      while (inflight.size >= queue.concurrency) {
        await Promise.race([...inflight]);
      }
      // Advance cursor past non-pending jobs
      while (
        cursor < queue.jobs.length &&
        queue.jobs[cursor].status !== 'pending'
      ) {
        cursor++;
      }
      if (cursor >= queue.jobs.length) {
        if (inflight.size === 0) break;
        await Promise.race([...inflight]);
        continue;
      }
      const job = queue.jobs[cursor++];
      job.status = 'running';
      rerenderQueue();
      persistQueue();
      const p = invoke('run_render', { req: job.req })
        .then((out) => {
          job.status = 'done';
          job.outPath = out;
        })
        .catch((err) => {
          const msg = typeof err === 'string' ? err : String(err);
          job.status = msg === 'cancelled' ? 'cancelled' : 'error';
          job.error = msg;
        })
        .finally(() => {
          inflight.delete(p);
          rerenderQueue();
          persistQueue();
        });
      inflight.add(p);
    }
  } finally {
    _isRunning = false;
    persistQueue();
  }
}

export function cancelJob(id) {
  const job = queue.jobs.find((j) => j.id === id);
  if (!job || job.status !== 'running') return;
  import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke('cancel_render', { reelId: id }))
    .catch(() => {});
}

export function cancelAll() {
  for (const job of queue.jobs) {
    if (job.status === 'running') {
      import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke('cancel_render', { reelId: job.id }))
        .catch(() => {});
    } else if (job.status === 'pending') {
      job.status = 'cancelled';
    }
  }
  rerenderQueue();
  persistQueue();
}

export function clearDone() {
  queue.jobs = queue.jobs.filter((j) => j.status !== 'done');
  rerenderQueue();
  persistQueue();
}
