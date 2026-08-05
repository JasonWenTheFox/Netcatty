import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planPluginSyncCredential, pluginSyncSecretStoreKeys, syncConfigurationSchemaWithoutSecretRequirements } from './pluginSyncCredential.ts';

describe('planPluginSyncCredential', () => {
  it('extracts all secret keys and strips them from configuration', () => {
    const plan = planPluginSyncCredential({
      endpoint: 'https://dav.example',
      username: 'alice',
      password: 's3cret',
      token: 'also-secret',
    });
    assert.equal(plan.plaintextSecret, 's3cret');
    assert.equal(plan.extractedFrom, 'password');
    assert.equal(plan.secrets.length, 2);
    assert.deepEqual(
      plan.secrets.map((entry) => ({ key: entry.key, value: entry.value })),
      [
        { key: 'password', value: 's3cret' },
        { key: 'token', value: 'also-secret' },
      ],
    );
    assert.deepEqual(plan.configuration, {
      endpoint: 'https://dav.example',
      username: 'alice',
    });
  });

  it('passes through non-object configs unchanged', () => {
    assert.deepEqual(planPluginSyncCredential(null), {
      configuration: null,
      secrets: [],
      secretKey: 'sync-credential',
    });
    assert.deepEqual(planPluginSyncCredential('x'), {
      configuration: 'x',
      secrets: [],
      secretKey: 'sync-credential',
    });
  });

  it('leaves configs without secrets alone', () => {
    const configuration = { endpoint: 'https://dav.example', username: 'alice' };
    assert.deepEqual(planPluginSyncCredential(configuration), {
      configuration,
      secrets: [],
      secretKey: 'sync-credential',
    });
  });
});

describe('syncConfigurationSchemaWithoutSecretRequirements', () => {
  it('drops known secret keys from required', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        endpoint: { type: 'string' },
        password: { type: 'string' },
      },
      required: ['endpoint', 'password'],
    };
    assert.deepEqual(syncConfigurationSchemaWithoutSecretRequirements(schema), {
      ...schema,
      required: ['endpoint'],
    });
  });
});

describe('pluginSyncSecretStoreKeys', () => {
  it('includes primary and secondary credential keys', () => {
    assert.ok(pluginSyncSecretStoreKeys().includes('sync-credential'));
    assert.ok(pluginSyncSecretStoreKeys().includes('sync-credential:token'));
  });
});
