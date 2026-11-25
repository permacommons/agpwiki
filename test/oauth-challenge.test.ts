import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildBearerChallenge,
  getIssuerUrl,
  getProtectedResourceMetadataUrl,
  getResourceServerUrl,
} from '../src/auth/oauth.js';

const fakeRequest = (protocol: string, host?: string) => ({
  protocol,
  get: (name: string) => (name.toLowerCase() === 'host' ? host : undefined),
});

test('getIssuerUrl derives the issuer from the request when not configured', () => {
  const issuer = getIssuerUrl(fakeRequest('https', 'wiki.example'));
  assert.equal(issuer.href, 'https://wiki.example/');
});

test('getIssuerUrl rejects requests without a Host header', () => {
  assert.throws(() => getIssuerUrl(fakeRequest('https')), /Missing Host header/);
});

test('resource and metadata URLs share the issuer origin', () => {
  const issuer = new URL('https://wiki.example');
  assert.equal(getResourceServerUrl(issuer).href, 'https://wiki.example/mcp');
  assert.equal(
    getProtectedResourceMetadataUrl(issuer).href,
    'https://wiki.example/.well-known/oauth-protected-resource/mcp'
  );
});

test('buildBearerChallenge lists resource metadata and scopes', () => {
  const challenge = buildBearerChallenge({
    resourceMetadataUrl: new URL('https://wiki.example/.well-known/oauth-protected-resource/mcp'),
    scopes: ['mcp.read', 'mcp.write'],
  });
  assert.equal(
    challenge,
    'Bearer resource_metadata="https://wiki.example/.well-known/oauth-protected-resource/mcp", scope="mcp.read mcp.write"'
  );
});

test('buildBearerChallenge adds invalid_token and omits empty scopes', () => {
  const challenge = buildBearerChallenge({
    resourceMetadataUrl: new URL('https://wiki.example/.well-known/oauth-protected-resource/mcp'),
    scopes: [],
    error: 'invalid_token',
  });
  assert.equal(
    challenge,
    'Bearer resource_metadata="https://wiki.example/.well-known/oauth-protected-resource/mcp", error="invalid_token"'
  );
});
