export const STORAGE_CLIENTS = {
  INTERNAL: 'STORAGE_INTERNAL_S3_CLIENT',
  PUBLIC: 'STORAGE_PUBLIC_S3_CLIENT',
} as const;

/** S3 error codes returned by CompleteMultipartUpload when the part list cannot be assembled. */
export const INVALID_MULTIPART_ERROR_CODES = [
  'InvalidPart',
  'InvalidPartOrder',
  'NoSuchUpload',
  'EntityTooSmall',
] as const;
