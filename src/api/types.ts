export type FileId = string;

export type ContentSource =
  | { readonly type: 'path'; readonly path: string }
  | { readonly type: 'bytes'; readonly bytes: Uint8Array }
  | { readonly type: 'text'; readonly text: string; readonly encoding?: 'utf-8' }
  | { readonly type: 'stream'; readonly stream: NodeJS.ReadableStream };

export interface FileRecord {
  readonly id: FileId;
  readonly byteLength: number;
  readonly createdAt: number;
}

export interface Connection {
  /** Stores a new immutable file and returns its ID. */
  readonly create: (content: ContentSource) => Promise<FileId>;

  /** Opens an immutable file as a readable stream. */
  readonly read: (fileId: FileId) => Promise<NodeJS.ReadableStream>;

  /** Reads an immutable file fully into memory. */
  readonly readBytes: (fileId: FileId) => Promise<Uint8Array>;

  /** Lists every stored file in creation order. */
  readonly listFiles: () => Promise<readonly FileRecord[]>;

  /** Assigns a stored file as the global root and records the assignment. */
  readonly setRoot: (fileId: FileId) => Promise<void>;

  /** Opens the current root file as a readable stream. */
  readonly readRoot: () => Promise<NodeJS.ReadableStream>;

  /** Reads the current root file fully into memory. */
  readonly readBytesRoot: () => Promise<Uint8Array>;
}

export interface CreateFileStoreOptions {
  readonly root: string;
  readonly readBytesLimit?: number;
}
