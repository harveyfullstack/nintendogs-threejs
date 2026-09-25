import type { Breed, CoatDef } from './breeds';
import { buildDogMesh, meshSimplifierReady, type DogMeshData } from './meshData';
import type { MeshRequest } from './meshWorker';

// Dog meshes are built by a small pool of workers so generating puppies never
// freezes the page, and several can be made at once (the kennel shows three).
// Where workers aren't available the mesh is built on the main thread instead.

interface Job { req: MeshRequest; resolve: (m: DogMeshData) => void; reject: (e: Error) => void }
interface Slot { worker: Worker; job: Job | null; idleTimer: number }

const IDLE_MS = 20000;
let nextId = 1;
const slots: Slot[] = [];
const queue: Job[] = [];
let workersBroken = typeof Worker === 'undefined';

function poolSize() {
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
  return Math.max(1, Math.min(3, cores - 1));
}

function spawn(): Slot | null {
  if (workersBroken) return null;
  try {
    const worker = new Worker(new URL('./meshWorker.ts', import.meta.url), { type: 'module' });
    const slot: Slot = { worker, job: null, idleTimer: 0 };
    worker.onmessage = (e: MessageEvent<{ id: number; mesh?: DogMeshData; error?: string }>) => {
      const job = slot.job;
      slot.job = null;
      if (job && job.req.id === e.data.id) {
        if (e.data.mesh) job.resolve(e.data.mesh);
        else job.reject(new Error(e.data.error ?? 'mesh worker failed'));
      }
      pump();
    };
    worker.onerror = (e) => {
      // the worker couldn't start (or crashed): build this and everything after on the main thread
      e.preventDefault?.();
      workersBroken = true;
      const job = slot.job;
      slot.job = null;
      retire(slot);
      if (job) queue.unshift(job);
      for (const s of [...slots]) if (!s.job) retire(s);
      pump();
    };
    slots.push(slot);
    return slot;
  } catch {
    workersBroken = true;
    return null;
  }
}

function retire(slot: Slot) {
  clearTimeout(slot.idleTimer);
  slot.worker.terminate();
  const i = slots.indexOf(slot);
  if (i >= 0) slots.splice(i, 1);
}

function pump() {
  while (queue.length) {
    if (workersBroken) {
      const job = queue.shift()!;
      // let the page draw a frame first, then do the work here
      setTimeout(() => void buildHere(job), 0);
      continue;
    }
    let slot = slots.find((s) => !s.job);
    if (!slot && slots.length < poolSize()) slot = spawn() ?? undefined;
    if (!slot) {
      if (workersBroken) continue;
      return; // all busy: the next one to finish pumps again
    }
    const job = queue.shift()!;
    slot.job = job;
    clearTimeout(slot.idleTimer);
    slot.worker.postMessage(job.req);
  }
  // workers hold a few MB each: let idle ones go
  for (const s of slots) {
    if (s.job) continue;
    clearTimeout(s.idleTimer);
    s.idleTimer = window.setTimeout(() => { if (!s.job) retire(s); }, IDLE_MS);
  }
}

async function buildHere(job: Job) {
  try {
    await meshSimplifierReady();
    const { getBreed } = await import('./breeds');
    const breed = getBreed(job.req.breedId);
    const coat = breed.coats.find((c) => c.id === job.req.coatId) ?? breed.coats[0];
    job.resolve(buildDogMesh(breed, coat, { quality: job.req.quality }));
  } catch (e) {
    job.reject(e instanceof Error ? e : new Error(String(e)));
  }
}

/** Build a dog's skin mesh without blocking the page. */
export function buildDogMeshAsync(breed: Breed, coat: CoatDef, quality: number): Promise<DogMeshData> {
  return new Promise((resolve, reject) => {
    queue.push({ req: { id: nextId++, breedId: breed.id, coatId: coat.id, quality }, resolve, reject });
    pump();
  });
}
