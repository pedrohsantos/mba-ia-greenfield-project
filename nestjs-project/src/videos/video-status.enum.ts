/**
 * Upload/processing lifecycle of a video (Phase 03).
 * `draft` = pre-registered, upload pending. Publication state is a separate Phase 04 concern.
 */
export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}
