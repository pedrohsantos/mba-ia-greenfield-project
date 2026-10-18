import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ACCESS_KEY: 'access',
  S3_SECRET_KEY: 'secret-key',
};

interface EnvValidation {
  error?: Error;
  value: Record<string, unknown>;
}

const validate = (env: Record<string, string>): EnvValidation =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  ) as EnvValidation;

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage and queue', () => {
  it('should reject a missing S3_ACCESS_KEY', () => {
    const { error } = envValidationSchema.validate(
      { ...requiredEnv, S3_ACCESS_KEY: undefined },
      { allowUnknown: true, abortEarly: false },
    ) as EnvValidation;
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ACCESS_KEY');
  });

  it('should reject a missing S3_SECRET_KEY', () => {
    const { error } = envValidationSchema.validate(
      { ...requiredEnv, S3_SECRET_KEY: undefined },
      { allowUnknown: true, abortEarly: false },
    ) as EnvValidation;
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_SECRET_KEY');
  });

  it('should apply storage and queue defaults', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      S3_ENDPOINT: 'http://minio:9000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'streamtube-videos',
      S3_PRESIGN_EXPIRES_SECONDS: 3600,
      REDIS_HOST: 'redis',
      REDIS_PORT: 6379,
      QUEUE_PREFIX: 'streamtube',
    });
  });

  it('should reject a non-URI S3_ENDPOINT', () => {
    const { error } = validate({ S3_ENDPOINT: 'not a url' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_ENDPOINT');
  });
});
