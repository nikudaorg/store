import { Connection } from '../src/api/types';
import { store } from './store';

const createEntity = async (conn: Connection) => {
  console.log(await conn.verify());
  const entity = await conn.create({
    content: { type: 'text', text: 'Hello store!' }
  });
  console.log(
    `Entity ID: ${entity.entityId}\nRevision ID: ${entity.revisionId}`
  );
};

const checkEntity = async (conn: Connection) => {
  console.log(await conn.verify());
  console.log(await conn.getRevision('ent_rwntqb5umucrrkta66rhy5eeywiqzcxf'));
  console.log(
    new TextDecoder('utf-8').decode(
      await conn.readBytes('ent_rwntqb5umucrrkta66rhy5eeywiqzcxf')
    )
  );
  console.log(
    new TextDecoder('utf-8').decode(
      await conn.readBytes(
        'ent_rwntqb5umucrrkta66rhy5eeywiqzcxf',
        'rev_pmawafamdwc47zgrsrvqglofwmiq2e4f'
      )
    )
  );
  console.log(
    new TextDecoder('utf-8').decode(
      await conn.readBytes(
        'ent_rwntqb5umucrrkta66rhy5eeywiqzcxf',
        'rev_3ld7ccsfzw2emzohiu4kklkxxjchecan'
      )
    )
  );
};

const commitToEntity = async (conn: Connection) => {
  console.log(await conn.verify());
  console.log(
    (
      await conn.commit({
        entityId: 'ent_rwntqb5umucrrkta66rhy5eeywiqzcxf',
        content: { type: 'text', text: 'Goodbye store!' }
      })
    ).revisionId
  );
};

await store(checkEntity);
