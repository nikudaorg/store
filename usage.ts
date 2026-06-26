import { createVersionedEntityStore } from './src';

await createVersionedEntityStore(
  {
    root: './usage-test'
  },
  async (store) => {
    await store.verify();
  }
);
