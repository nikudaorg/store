import type { FileStore } from '../src/index.js';
import { store } from './store.js';

const createFile = async (connection: FileStore) => {
  const fileId = await connection.create({
    type: 'text',
    text: 'Hello store!'
  });
  await connection.setRoot(fileId);
  console.log(`File ID: ${fileId}`);
};

const readRoot = async (connection: FileStore) => {
  console.log(new TextDecoder('utf-8').decode(await connection.readBytesRoot()));
};

await store(createFile);
await store(readRoot);
