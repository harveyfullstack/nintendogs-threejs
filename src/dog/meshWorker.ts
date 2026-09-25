// Builds dog skin meshes off the main thread (see meshPool.ts). Sculpting, meshing
// and painting a puppy takes around a second, several on a phone: done here, the
// page keeps animating while it happens.

import { getBreed } from './breeds';
import { buildDogMesh, meshSimplifierReady, meshTransferables } from './meshData';

export interface MeshRequest { id: number; breedId: string; coatId: string; quality: number }

const ready = meshSimplifierReady();
const post = (self as unknown as { postMessage(message: unknown, transfer?: Transferable[]): void }).postMessage.bind(self);

self.onmessage = async (e: MessageEvent<MeshRequest>) => {
  const { id, breedId, coatId, quality } = e.data;
  try {
    await ready;
    const breed = getBreed(breedId);
    const coat = breed.coats.find((c) => c.id === coatId) ?? breed.coats[0];
    const mesh = buildDogMesh(breed, coat, { quality });
    post({ id, mesh }, meshTransferables(mesh));
  } catch (err) {
    post({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
