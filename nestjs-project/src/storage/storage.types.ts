export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface PresignedUrl {
  url: string;
  expiresAt: Date;
}

export type StorageEndpoint = 'public' | 'internal';

export interface PresignGetOptions {
  /** `public` for URLs handed to clients, `internal` for server-side consumers (worker). */
  endpoint: StorageEndpoint;
  /** When set, the URL forces a download with this file name. */
  downloadFileName?: string;
}
