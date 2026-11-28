// AIDEV-NOTE: PMR-ZV9Y (4.2) — the `telemetry.loki` config surface. Deliberately
// a NEW file (additive-test rule, the run-health.test.ts precedent): config.test.ts
// pins the liveness/reconcile blocks individually and NEVER asserts the whole
// default config object, so it does not have to grow for loki. These tests cover
// the SESSION-SIDE SINGLE STRICT READER boundary — readConfigFile throws on a
// malformed telemetry block, resolveLokiSettings surfaces the disabled-by-default
// shape, and config.schema.json mirrors the block with the pinned `enabled`
// default. PMR-VSST relaxed the PMR-R8AG coupling: `otlpEndpoint` is now
// schema-OPTIONAL so a loki-only config (telemetry.enabled false +
// telemetry.loki.enabled true, no OTLP base) parses; the remaining rule —
// telemetry.enabled true REQUIRES otlpEndpoint — is enforced by an explicit
// check at the same readConfigFile boundary (pinned below).
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Value } from 'typebox/value'
import { readConfigFile, resolveLokiSettings } from '../config.ts'

async function configWith(
  t: { after(fn: () => Promise<unknown>): void },
  obj: unknown,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-flow-loki-'))
  t.after(async () => await rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'config.json')
  await writeFile(file, JSON.stringify(obj))
  return file
}

// A complete, VALID OTLP telemetry block (PMR-R8AG shape): `enabled` plus its
// required `otlpEndpoint`. Since PMR-VSST the endpoint is only required when
// `enabled` is true — a loki-only block may omit it (pinned below).
const TELEMETRY_BASE = {
  telemetry: { enabled: true, otlpEndpoint: 'https://tempo.example.com:4478' },
}

test('readConfigFile: telemetry.loki block accepted and read back (PMR-ZV9Y 4.2)', async (t) => {
  const file = await configWith(t, {
    workRoots: [],
    telemetry: {
      ...TELEMETRY_BASE.telemetry,
      loki: {
        enabled: true,
        endpoint: 'http://100.108.226.64:3100',
        headers: { authorization: 'Bearer x' },
      },
    },
  })
  const cfg = await readConfigFile(file)
  assert.deepEqual(cfg.telemetry?.loki, {
    enabled: true,
    endpoint: 'http://100.108.226.64:3100',
    headers: { authorization: 'Bearer x' },
  })
})

test('readConfigFile: telemetry.loki absent → resolveLokiSettings is disabled by default (PMR-ZV9Y 4.2)', async (t) => {
  const file = await configWith(t, { workRoots: [], ...TELEMETRY_BASE })
  const cfg = await readConfigFile(file)
  assert.equal(cfg.telemetry?.loki, undefined)
  assert.deepEqual(resolveLokiSettings(cfg), {
    enabled: false,
    endpoint: '',
    headers: {},
  })
})

test('readConfigFile: no telemetry block at all → resolveLokiSettings disabled (PMR-ZV9Y 4.2)', async (t) => {
  const file = await configWith(t, { workRoots: [] })
  const cfg = await readConfigFile(file)
  assert.deepEqual(resolveLokiSettings(cfg), {
    enabled: false,
    endpoint: '',
    headers: {},
  })
})

test('readConfigFile: telemetry.loki partial block fills the disabled default (PMR-ZV9Y 4.2)', async (t) => {
  const file = await configWith(t, {
    workRoots: [],
    telemetry: {
      ...TELEMETRY_BASE.telemetry,
      loki: { endpoint: 'http://100.108.226.64:3100' },
    },
  })
  const cfg = await readConfigFile(file)
  // endpoint set but enabled still absent → defaults to false (zero calls).
  assert.deepEqual(resolveLokiSettings(cfg), {
    enabled: false,
    endpoint: 'http://100.108.226.64:3100',
    headers: {},
  })
})

// A present loki block must round-trip the copy-on-read headers so a mutation
// of the returned object cannot corrupt the cached config object.
test('resolveLokiSettings: headers are copied, not aliased (PMR-ZV9Y 4.2)', () => {
  const cfg = {
    workRoots: [],
    telemetry: {
      enabled: true,
      otlpEndpoint: 'https://t:4478',
      loki: { enabled: true, endpoint: 'http://l:3100', headers: { a: 'b' } },
    },
  }
  const settings = resolveLokiSettings(cfg)
  settings.headers.c = 'mutated'
  assert.deepEqual(cfg.telemetry.loki.headers, { a: 'b' })
})

test('readConfigFile: telemetry.loki.enabled non-boolean → clear throw (PMR-ZV9Y 4.2)', async (t) => {
  const file = await configWith(t, {
    workRoots: [],
    telemetry: {
      ...TELEMETRY_BASE.telemetry,
      loki: { enabled: 'yes' },
    },
  })
  await assert.rejects(readConfigFile(file), /enabled/)
})

test('readConfigFile: telemetry.loki.headers value non-string → clear throw (PMR-ZV9Y 4.2)', async (t) => {
  const file = await configWith(t, {
    workRoots: [],
    telemetry: {
      ...TELEMETRY_BASE.telemetry,
      loki: { headers: { authorization: 123 } },
    },
  })
  await assert.rejects(readConfigFile(file), /headers/)
})

// AIDEV-NOTE: PMR-VSST — the relaxed telemetry contract. `otlpEndpoint` is
// schema-optional so a loki-only user needs no OTLP base; the surviving
// coupling (telemetry.enabled true → otlpEndpoint required) is an explicit
// readConfigFile boundary check, pinned here by its error naming the key.
test('readConfigFile: loki-only telemetry (enabled false, no otlpEndpoint) parses and resolves (PMR-VSST)', async (t) => {
  const file = await configWith(t, {
    workRoots: [],
    telemetry: {
      enabled: false,
      loki: { enabled: true, endpoint: 'http://loki.example.com:3100' },
    },
  })
  const cfg = await readConfigFile(file)
  assert.equal(cfg.telemetry?.otlpEndpoint, undefined)
  assert.deepEqual(resolveLokiSettings(cfg), {
    enabled: true,
    endpoint: 'http://loki.example.com:3100',
    headers: {},
  })
})

test('readConfigFile: telemetry.enabled true without otlpEndpoint → clear throw naming the key (PMR-VSST)', async (t) => {
  const file = await configWith(t, {
    workRoots: [],
    telemetry: {
      enabled: true,
      loki: { enabled: true, endpoint: 'http://loki.example.com:3100' },
    },
  })
  await assert.rejects(readConfigFile(file), /otlpEndpoint/)
})

// Preservation pins: both pre-PMR-VSST shapes must keep parsing unchanged.
test('readConfigFile: telemetry.enabled false WITH otlpEndpoint still parses (PMR-VSST preservation)', async (t) => {
  const file = await configWith(t, {
    workRoots: [],
    telemetry: {
      enabled: false,
      otlpEndpoint: 'https://tempo.example.com:4478',
    },
  })
  const cfg = await readConfigFile(file)
  assert.equal(cfg.telemetry?.otlpEndpoint, 'https://tempo.example.com:4478')
})

// config.schema.json is the checked-in editor-facing mirror of
// PiFlowConfigSchema. It must describe the telemetry.loki block with the
// documented default (enabled false) and reject a malformed one.
test('config.schema.json: telemetry.loki section mirrors the schema (PMR-ZV9Y 4.2)', async () => {
  const raw = await readFile(
    new URL('../config.schema.json', import.meta.url),
    'utf8',
  )
  const schema = JSON.parse(raw) as {
    properties: Record<string, unknown>
  }
  const telemetry = schema.properties.telemetry as {
    properties: Record<
      string,
      {
        type: string
        default?: unknown
        additionalProperties?: unknown
        properties?: Record<string, { type: string; default?: unknown }>
      }
    >
  }
  const loki = telemetry.properties.loki
  assert.equal(loki.type, 'object')
  assert.equal(loki.additionalProperties, false)
  assert.equal(loki.properties?.enabled.type, 'boolean')
  assert.equal(loki.properties?.enabled.default, false)
  assert.equal(loki.properties?.endpoint.type, 'string')
  assert.equal(loki.properties?.headers.type, 'object')
})

test('config.schema.json: validates a documented loki example and rejects bad shapes (PMR-ZV9Y 4.2)', async () => {
  const raw = await readFile(
    new URL('../config.schema.json', import.meta.url),
    'utf8',
  )
  const schema = JSON.parse(raw)
  assert.equal(
    Value.Check(schema as never, {
      $schema: 'x',
      workRoots: [],
      telemetry: {
        enabled: true,
        otlpEndpoint: 'https://t:4478',
        loki: {
          enabled: false,
          endpoint: 'http://100.108.226.64:3100',
          headers: {},
        },
      },
    }),
    true,
  )
  assert.equal(
    Value.Check(schema as never, {
      workRoots: [],
      telemetry: {
        enabled: true,
        otlpEndpoint: 'https://t:4478',
        loki: { enabled: 'no' },
      },
    }),
    false,
  )
  assert.equal(
    Value.Check(schema as never, {
      workRoots: [],
      telemetry: {
        enabled: true,
        otlpEndpoint: 'https://t:4478',
        loki: { endpoint: 3100 },
      },
    }),
    false,
  )
})

// PMR-VSST — the mirror must relax with the TypeBox source: `otlpEndpoint`
// drops out of telemetry.required (only `enabled` stays required), a loki-only
// example validates, and the full OTLP example keeps validating.
test('config.schema.json: telemetry no longer requires otlpEndpoint; loki-only example validates (PMR-VSST)', async () => {
  const raw = await readFile(
    new URL('../config.schema.json', import.meta.url),
    'utf8',
  )
  const schema = JSON.parse(raw) as {
    properties: { telemetry: { required?: string[] } }
  }
  assert.deepEqual(schema.properties.telemetry.required, ['enabled'])
  // Loki-only: telemetry.enabled false + loki.enabled true, no otlpEndpoint.
  assert.equal(
    Value.Check(schema as never, {
      workRoots: [],
      telemetry: {
        enabled: false,
        loki: { enabled: true, endpoint: 'http://loki.example.com:3100' },
      },
    }),
    true,
  )
  // The pre-PMR-VSST OTLP shape keeps validating.
  assert.equal(
    Value.Check(schema as never, {
      workRoots: [],
      telemetry: {
        enabled: true,
        otlpEndpoint: 'https://tempo.example.com:4478',
      },
    }),
    true,
  )
})
