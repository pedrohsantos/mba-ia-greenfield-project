import { DomainException } from '../../common/exceptions/domain.exception';

export class ChannelNotFoundException extends DomainException {
  constructor() {
    super(
      'CHANNEL_NOT_FOUND',
      404,
      'Channel not found for the authenticated user',
    );
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class InvalidVideoStatusException extends DomainException {
  constructor() {
    super(
      'INVALID_VIDEO_STATUS',
      409,
      'Video is not in a valid status for this operation',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready for playback');
  }
}

export class UploadPartsInvalidException extends DomainException {
  constructor() {
    super(
      'UPLOAD_PARTS_INVALID',
      400,
      'Uploaded parts are invalid or incomplete',
    );
  }
}

export class UploadSizeMismatchException extends DomainException {
  constructor() {
    super(
      'UPLOAD_SIZE_MISMATCH',
      400,
      'Uploaded file size does not match the declared size',
    );
  }
}
