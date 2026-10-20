/**
 * Unit tests for lib/privacy.js — credential redaction, text sanitization and
 * the sensitive-topic policy labels.
 *
 * Run from the plugin root:
 *   node --test test/privacy.test.js
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  CREDENTIAL_PATTERNS,
  HARD_SENSITIVE_TOPICS,
  REDACTED,
  SENSITIVE_TOPICS,
  looksCredentialLike,
  redactSecrets,
  sanitizeText,
  sensitivePolicyText,
} from '../lib/privacy.js'

const SK = `sk-${'a1B2c3D4e5F6g7H8'}`
const GHP = `ghp_${'A1B2C3D4E5F6G7H8I9J0'}`
const AKIA = `AKIA${'A1B2C3D4E5F6G7H8'}`
const BEARER = 'abc123DEF456ghi789'
const PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEowIBAAKCAQEAverysecretkeymaterial',
  '-----END RSA PRIVATE KEY-----',
].join('\n')

describe('constants', () => {
  it('exposes the redaction marker, patterns and sensitive topic groups', () => {
    assert.equal(REDACTED, '[REDACTED]')
    assert.ok(CREDENTIAL_PATTERNS.length >= 6)
    assert.ok(CREDENTIAL_PATTERNS.every((pattern) => pattern instanceof RegExp))
    assert.ok(HARD_SENSITIVE_TOPICS.length > 0)
    assert.ok(SENSITIVE_TOPICS.length > 0)
    assert.ok(HARD_SENSITIVE_TOPICS.some((topic) => topic.includes('credentials')))
    assert.ok(SENSITIVE_TOPICS.some((topic) => topic.includes('health')))
  })
})

describe('redactSecrets', () => {
  it('redacts OpenAI/DeepSeek-style sk- keys and preserves surrounding text', () => {
    const result = redactSecrets(`Use ${SK} for this request.`)
    assert.equal(result.text, 'Use [REDACTED] for this request.')
    assert.equal(result.text.includes(SK), false)
    assert.equal(result.hits.length, 1)
    assert.match(result.hits[0], /sk-/)
  })

  it('redacts GitHub ghp_ tokens', () => {
    const result = redactSecrets(`token=${GHP}`)
    assert.equal(result.text, 'token=[REDACTED]')
    assert.equal(result.text.includes(GHP), false)
    assert.equal(result.hits.length, 1)
    assert.match(result.hits[0], /gh/)
  })

  it('redacts AWS AKIA access key ids', () => {
    const result = redactSecrets(`aws ${AKIA} found`)
    assert.equal(result.text, 'aws [REDACTED] found')
    assert.equal(result.text.includes(AKIA), false)
    assert.equal(result.hits.length, 1)
    assert.match(result.hits[0], /AKIA/)
  })

  it('redacts Bearer authorization tokens', () => {
    const result = redactSecrets(`Authorization: Bearer ${BEARER}`)
    assert.equal(result.text, 'Authorization: [REDACTED]')
    assert.equal(result.text.includes(BEARER), false)
    assert.equal(result.hits.length, 1)
    assert.match(result.hits[0], /Bearer/)
  })

  it('redacts PEM private key blocks', () => {
    const result = redactSecrets(`before\n${PEM}\nafter`)
    assert.equal(result.text, 'before\n[REDACTED]\nafter')
    assert.equal(result.text.includes('BEGIN RSA PRIVATE KEY'), false)
    assert.equal(result.text.includes('verysecretkeymaterial'), false)
    assert.equal(result.hits.length, 1)
  })

  it('redacts password= assignments', () => {
    const result = redactSecrets('set password=supersecret now')
    assert.equal(result.text, 'set [REDACTED] now')
    assert.equal(result.text.includes('supersecret'), false)
    assert.equal(result.hits.length, 1)
  })

  it('redacts api_key: assignments', () => {
    const result = redactSecrets('config api_key: abcdef123456 here')
    assert.equal(result.text, 'config [REDACTED] here')
    assert.equal(result.text.includes('abcdef123456'), false)
    assert.equal(result.hits.length, 1)
  })

  it('redacts several credentials in one pass and reports each hit', () => {
    const result = redactSecrets(`${SK} and ${GHP}`)
    assert.equal(result.text, '[REDACTED] and [REDACTED]')
    assert.equal(result.text.includes(SK), false)
    assert.equal(result.text.includes(GHP), false)
    assert.equal(result.hits.length, 2)
  })

  it('leaves ordinary prose untouched', () => {
    const prose = 'The password is stored elsewhere; use the keychain app.'
    const result = redactSecrets(prose)
    assert.deepEqual(result, { text: prose, hits: [] })
    assert.equal(redactSecrets('sk-short is not a key').text, 'sk-short is not a key')
  })

  it('handles empty and non-string input', () => {
    assert.deepEqual(redactSecrets(''), { text: '', hits: [] })
    assert.deepEqual(redactSecrets(null), { text: '', hits: [] })
    assert.deepEqual(redactSecrets(42), { text: '', hits: [] })
    assert.deepEqual(redactSecrets(undefined), { text: '', hits: [] })
  })

  it('is deterministic across repeated calls (global regex state is reset)', () => {
    const input = `key ${SK}`
    assert.deepEqual(redactSecrets(input), redactSecrets(input))
    assert.deepEqual(redactSecrets(input), redactSecrets(input))
  })
})

describe('looksCredentialLike', () => {
  it('detects each supported credential shape', () => {
    assert.equal(looksCredentialLike(SK), true)
    assert.equal(looksCredentialLike(GHP), true)
    assert.equal(looksCredentialLike(AKIA), true)
    assert.equal(looksCredentialLike(`Bearer ${BEARER}`), true)
    assert.equal(looksCredentialLike(PEM), true)
    assert.equal(looksCredentialLike('password=supersecret'), true)
    assert.equal(looksCredentialLike('api_key: abcdef123456'), true)
  })

  it('returns false for prose, empty values and short lookalikes', () => {
    assert.equal(looksCredentialLike('Nothing secret here, just prose.'), false)
    assert.equal(looksCredentialLike(''), false)
    assert.equal(looksCredentialLike('sk-short'), false)
    assert.equal(looksCredentialLike('the password is in the keychain'), false)
    assert.equal(looksCredentialLike(null), false)
    assert.equal(looksCredentialLike(42), false)
  })

  it('no longer flags text after redaction', () => {
    const redacted = redactSecrets(`${SK} ${GHP}`).text
    assert.equal(looksCredentialLike(redacted), false)
  })
})

describe('sanitizeText', () => {
  it('strips control characters and trims', () => {
    const result = sanitizeText('\u0000  a\u0000b\u0001c\u0007d\u007fe  \u0000', 1000)
    assert.equal(result.text, 'abcde')
    assert.deepEqual(result.hits, [])
  })

  it('normalizes CRLF and collapses long blank runs', () => {
    const input = '  line one   \r\nline two\r\n\r\n\r\n\r\nline three  '
    const result = sanitizeText(input, 1000)
    assert.equal(result.text, 'line one\nline two\n\nline three')
  })

  it('truncates with an ellipsis at the requested length', () => {
    const result = sanitizeText('word '.repeat(5), 20)
    assert.equal(result.text.length, 20)
    assert.equal(result.text, 'word word word word…')
    assert.ok(result.text.endsWith('…'))
  })

  it('leaves text below the limit unchanged', () => {
    assert.equal(sanitizeText('short text', 100).text, 'short text')
    assert.equal(sanitizeText('  padded  ', 100).text, 'padded')
  })

  it('redacts credentials before truncation and returns hits', () => {
    const secret = `sk-${'a'.repeat(16)}`
    const result = sanitizeText(`key ${secret}`, 200)
    assert.equal(result.text.includes(secret), false)
    assert.equal(result.text, 'key [REDACTED]')
    assert.equal(result.hits.length, 1)
  })

  it('supports opting out of redaction', () => {
    const result = sanitizeText('password=supersecret', 200, { redact: false })
    assert.equal(result.text, 'password=supersecret')
    assert.deepEqual(result.hits, [])
  })

  it('handles empty and non-string values', () => {
    assert.deepEqual(sanitizeText('', 100), { text: '', hits: [] })
    assert.deepEqual(sanitizeText(null, 100), { text: '', hits: [] })
    assert.deepEqual(sanitizeText(42, 100), { text: '', hits: [] })
  })
})

describe('sensitivePolicyText', () => {
  it('always lists the hard-sensitive never-store categories', () => {
    for (const settings of [undefined, { allowSensitive: false }, { allowSensitive: true }]) {
      const text = sensitivePolicyText(settings)
      assert.ok(text.startsWith('Never store: '))
      for (const topic of HARD_SENSITIVE_TOPICS) {
        assert.ok(text.includes(topic), `missing hard-sensitive topic: ${topic}`)
      }
    }
  })

  it('lists sensitive topics and the default refusal when allowSensitive is false', () => {
    const text = sensitivePolicyText({ allowSensitive: false })
    for (const topic of SENSITIVE_TOPICS) {
      assert.ok(text.includes(topic), `missing sensitive topic: ${topic}`)
    }
    assert.match(text, /Do not store sensitive personal topics by default/)
    assert.equal(text.includes('explicitly asks to remember'), false)
    assert.deepEqual(sensitivePolicyText(), text)
  })

  it('switches to explicit opt-in wording when allowSensitive is true', () => {
    const text = sensitivePolicyText({ allowSensitive: true })
    assert.match(text, /Sensitive personal topics are allowed only when the user explicitly asks to remember them\./)
    for (const topic of SENSITIVE_TOPICS) {
      assert.equal(text.includes(topic), false, `soft topic should not be listed when opted in: ${topic}`)
    }
  })

  it('only treats strict true as the opt-in flag', () => {
    assert.deepEqual(sensitivePolicyText({ allowSensitive: 'true' }), sensitivePolicyText())
    assert.deepEqual(sensitivePolicyText({}), sensitivePolicyText())
  })
})
