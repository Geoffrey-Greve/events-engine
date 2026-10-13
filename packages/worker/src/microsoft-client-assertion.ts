/**
 * Microsoft identity platform client-certificate auth.
 *
 * Certificate credentials replace `client_secret` with a signed JWT
 * `client_assertion`. The public certificate is uploaded to the Entra app;
 * Event Engine keeps only the private key in Cloudflare secrets.
 */

const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

export interface MicrosoftCertificateCredential {
  privateKeyPem: string;
  thumbprint: string;
}

export interface MicrosoftClientAssertionInput {
  clientId: string;
  tokenEndpoint: string;
  certificate: MicrosoftCertificateCredential;
}

function base64UrlEncodeBytes(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlEncodeJson(value: unknown): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function normalizeThumbprint(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error('Microsoft certificate thumbprint is empty');

  // Prefer accepting the SHA-1 hex thumbprint shown in Azure/openssl output.
  const hex = trimmed.replace(/[^a-fA-F0-9]/g, '');
  if (hex.length === 40) {
    const bytes = new Uint8Array(20);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return base64UrlEncodeBytes(bytes);
  }

  // Also allow callers to provide the already base64url-encoded x5t value.
  return trimmed.replace(/=+$/g, '');
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');

  if (!body) throw new Error('Microsoft certificate private key PEM is empty');

  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function importRsaPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

export async function buildMicrosoftClientAssertion({
  clientId,
  tokenEndpoint,
  certificate,
}: MicrosoftClientAssertionInput): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: 'RS256',
    typ: 'JWT',
    x5t: normalizeThumbprint(certificate.thumbprint),
  };
  const payload = {
    aud: tokenEndpoint,
    exp: now + 10 * 60,
    iss: clientId,
    jti: crypto.randomUUID(),
    nbf: now - 60,
    sub: clientId,
  };

  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(payload)}`;
  const key = await importRsaPrivateKey(certificate.privateKeyPem);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64UrlEncodeBytes(signature)}`;
}

export function appendMicrosoftClientAssertion(body: URLSearchParams, assertion: string): void {
  body.set('client_assertion_type', CLIENT_ASSERTION_TYPE);
  body.set('client_assertion', assertion);
}
