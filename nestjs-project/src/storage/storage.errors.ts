/** Raised when storage rejects a multipart operation because of the parts or the upload id. */
export class InvalidMultipartUploadError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'InvalidMultipartUploadError';
  }
}
